import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Pool, PoolClient } from "pg";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, GRAPH_COLUMN_MAXIMUM_BYTES } from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  catalogueDefaults,
  createUserWithOrganization,
  loadSeededFlows,
  truncateAll,
  withFailingInsert,
} from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { hashPassword } from "../identity/password.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

/** The refusals' words, exactly, the envelope's 413 included. */
const MESSAGES = {
  configurationNotFound: "Configuration not found",
  versionNotFound: "Version not found",
  organizationNotFound: "Organization not found",
  terms: "Accept the current Terms of Service to continue.",
  unauthenticated: "You need to sign in.",
  csrf: "This request is missing a required header.",
  invalid: "The request was not valid.",
  tooLarge: "The request body is too large.",
  versionPublished: "This version is published and can't be changed.",
  deleteForbidden: "Only the configuration's author or an organization admin can delete it.",
};

interface ConfigurationBody {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  createdBy: { userId: string; email: string } | null;
  published: boolean;
  collectorDistribution: string;
}

interface PageBody {
  items: ConfigurationBody[];
  nextCursor: string | null;
}

/** A version as the picker lists it. */
interface VersionSummaryBody {
  id: string;
  versionNumber: number;
  label: string | null;
  createdBy: { userId: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  publishedBy: { userId: string; email: string } | null;
  collectorVersion: string;
  collectorVersionDeprecated: boolean;
  collectorVersionDeprecatedNote: string | null;
}

interface VersionBody extends VersionSummaryBody {
  configurationId: string;
  yamlContent: string;
  nodes: unknown[];
  edges: unknown[];
  pipelines: unknown[];
}

/** Both reads' answer. */
interface WithVersionBody {
  configuration: ConfigurationBody;
  version: VersionBody;
  versions: VersionSummaryBody[];
}

/** Ids that aren't canonical UUIDs, as a path segment carries them. */
const MALFORMED_PATH_IDS = ["not-a-uuid", "42", "0192F1A47B3C7D2E8F101A2B3C4D5E6F", "%7B0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f%7D"];

/** Ids that aren't canonical UUIDs, as a body carries them. */
const MALFORMED_BODY_IDS = ["not-a-uuid", "42", "0192F1A47B3C7D2E8F101A2B3C4D5E6F", "{0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f}", ""];

/** A save's graph when the test is about the text (the save carries all four). */
const EMPTY_GRAPH = { nodes: [], edges: [], pipelines: [] };

/** A graph column's bound: 1 MiB of JSON in UTF-8 bytes. */
const GRAPH_COLUMN_BYTES = GRAPH_COLUMN_MAXIMUM_BYTES;

/** The server's body limit for a save, and the gateway's for its path. */
const SAVE_BODY_LIMIT = 5_242_880;

/**
 * A small graph, hand-written in the shapes the builder stores: a pipeline's
 * group, two components in it, an edge between them, and the pipeline.
 */
const GRAPH = {
  nodes: [
    {
      id: "group_0",
      type: "pipelineGroup",
      position: { x: 50, y: 30 },
      style: { width: 980, height: 240 },
      data: { label: "traces/production", pipelineId: "pipeline_0", signalType: "traces", color: "#f97316" },
    },
    {
      id: "node_0",
      type: "receiver",
      parentId: "group_0",
      position: { x: 50.5, y: 70 },
      data: {
        label: "OTLP (edge)",
        componentType: "receiver",
        componentSubType: "otlp",
        instanceName: "edge",
        config: { protocols: { grpc: { endpoint: "0.0.0.0:4317" } }, zeta: [1, 2.5, true, null], alpha: "🚀" },
        sharedConfigId: "receiver-otlp/edge",
      },
    },
    {
      id: "node_1",
      type: "exporter",
      parentId: "group_0",
      position: { x: 300, y: -70 },
      data: { label: "Debug", componentType: "exporter", componentSubType: "debug", config: null },
    },
  ],
  edges: [{ id: "edge_0", source: "node_0", target: "node_1", type: "smoothstep" }],
  pipelines: [{ id: "pipeline_0", name: "traces/production", signalType: "traces", color: "#f97316" }],
};

/** The graph's first component: the node a test changes. */
const RECEIVER = GRAPH.nodes[1]!;

/** A fixture as a test changes it: any field, at the levels the graph's schemas have. */
interface Changeable {
  [field: string]: unknown;
  position: Record<string, unknown>;
  style?: Record<string, unknown>;
  data: Record<string, unknown> & { connectorSignals?: Record<string, unknown> };
}

/** A copy of the graph with its receiver changed by `change`. */
function graphWithReceiver(change: (receiver: Changeable) => void) {
  const graph = structuredClone(GRAPH);
  change(graph.nodes[1] as unknown as Changeable);
  return graph;
}

/**
 * A save at the contract's bounds: 262,144 × U+0001 of YAML, each six bytes
 * of JSON, and each column as close to 1 MiB of JSON as its bounds let it be:
 * 5,000 nodes, 10,000 edges and 1,000 pipelines whose names are escaped
 * U+0001s. A create from a flow carries the same content.
 */
const maximalSave = () => {
  const nodes: Record<string, unknown>[] = Array.from({ length: 5_000 }, (_, index) => ({
    id: `node_${100_000 + index}`,
    type: "processor",
    parentId: "group_100000",
    position: { x: -999_999.125, y: 999_999.125 },
    data: { label: "Batch", componentType: "processor", componentSubType: "batch", config: "" },
  }));
  const padding = GRAPH_COLUMN_BYTES - Buffer.byteLength(JSON.stringify(nodes));
  (nodes[0]!.data as Record<string, unknown>).config = "a".repeat(padding);
  const edges = Array.from({ length: 10_000 }, (_, index) => ({
    id: `edge_${100_000 + index}`,
    source: `node_${100_000 + (index % 5_000)}`,
    target: `node_${100_000 + ((index + 1) % 5_000)}`,
    type: "smoothstep",
  }));
  // `traces/` and 200 × U+0001 is 1,207 bytes of name, too many for
  // 1,000 of them: as many U+0001s each as fit.
  const base = Buffer.byteLength(
    JSON.stringify(
      Array.from({ length: 1_000 }, (_, index) => ({
        id: `pipeline_${100_000 + index}`,
        name: "traces/a",
        signalType: "metrics",
        color: "#aabbcc",
      })),
    ),
  );
  // Each U+0001 in place of the "a" adds 5 bytes of JSON, then 6 more each.
  const each = Math.floor((GRAPH_COLUMN_BYTES - base + 1_000) / 6_000);
  const pipelines = Array.from({ length: 1_000 }, (_, index) => ({
    id: `pipeline_${100_000 + index}`,
    name: `traces/${"\u0001".repeat(each)}`,
    signalType: "metrics",
    color: "#aabbcc",
  }));
  return { yamlContent: "\u0001".repeat(262_144), nodes, edges, pipelines };
};

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`the response set no ${name} cookie`);
  return line.slice(name.length + 1, line.indexOf(";"));
}

function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message: string): void {
  expect(response.statusCode).toBe(statusCode);
  expect(response.json()).toEqual({ error: { code, message } });
}

/** A 400 from a schema: the envelope's code and message, with the validation's details. */
function expectInvalid(response: LightMyRequestResponse): void {
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: "invalid_request", message: MESSAGES.invalid } });
}

/**
 * The configuration routes against Postgres, through the API as its own role,
 * with row-level security on `configurations` and `configuration_versions`.
 */
describe("configuration routes", () => {
  let settings: AppSettings;
  /** The tables' owner's pool, whose connections hold row locks. */
  let pool: Pool;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  /** The server's log lines since the test began, at info and above. */
  let logLines: string[] = [];

  /** The catalog's default distribution and its default version, as the tables hold them. */
  let pin: { distribution: string; version: string };
  /** Another, non-deprecated version of that distribution in the catalog. */
  let otherVersion: string;
  /** A summary's pin fields for a version at the default version: offered, so not deprecated. */
  let pinned: { collectorVersion: string; collectorVersionDeprecated: false; collectorVersionDeprecatedNote: null };

  beforeAll(async () => {
    settings = loadSettings(process.env);
    pool = createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerDb = createDb(pool);
    db = createDb(createPool(settings.databaseUrl));
    // Info, so each request's own log line is captured: the search text
    // must not be in it, nor a save's YAML.
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
    pin = await catalogueDefaults(ownerDb);
    const other = await ownerDb
      .selectFrom("collector_versions")
      .select("version")
      .where("distribution", "=", pin.distribution)
      .where("is_default", "=", false)
      .where("deprecated", "=", false)
      .orderBy("version", "desc")
      .executeTakeFirstOrThrow();
    otherVersion = other.version;
    pinned = { collectorVersion: pin.version, collectorVersionDeprecated: false, collectorVersionDeprecatedNote: null };
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    // Whole milliseconds, as the API's clock always is.
    clock = new Date(Math.floor(Date.now() / 1000) * 1000);
    logLines = [];
  });

  /** Moves the server's clock on. Seconds, not hours: the access tokens read the same clock. */
  const tick = (milliseconds = 1_000) => {
    clock = new Date(clock.getTime() + milliseconds);
    return clock;
  };

  const verifiedUser = (overrides: Parameters<typeof createUserWithOrganization>[1] = {}) =>
    createUserWithOrganization(ownerDb, {
      ...overrides,
      user: {
        email: `person-${Math.random().toString(36).slice(2)}@example.com`,
        password_hash: passwordHash,
        ...overrides.user,
      },
    });

  /** Signs in, which lands in the personal organization; the access cookie's value. */
  const signedIn = async (email: string) => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return cookieValue(response, "telflo_access");
  };

  const switchTo = async (access: string, organizationId: string) => {
    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { organizationId },
    });
    expect(response.statusCode).toBe(200);
    // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
    return response.headers["set-cookie"] === undefined ? access : cookieValue(response, "telflo_access");
  };

  /** A signed-in user, active in their personal organization. */
  const personalUser = async (overrides: Parameters<typeof createUserWithOrganization>[1] = {}) => {
    const account = await verifiedUser(overrides);
    return { account, organization: account.organization, access: await signedIn(account.user.email) };
  };

  /** A signed-in user who is a `role` of a group organization (a new one unless given) and active in it. */
  const memberActiveInGroup = async (role: OrganizationRole = "admin", organizationId?: string) => {
    const account = await verifiedUser();
    const { organization: group } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const access = await switchTo(await signedIn(account.user.email), group.id);
    return { account, personal: account.organization, group, access };
  };

  const path = (organizationId: string, configurationId?: string) =>
    `/api/v1/organizations/${organizationId}/configurations${configurationId === undefined ? "" : `/${configurationId}`}`;

  const list = (access: string | undefined, organizationId: string, query = "") =>
    server.inject({
      method: "GET",
      url: `${path(organizationId)}${query}`,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  const create = (
    access: string | undefined,
    organizationId: string,
    payload: unknown,
    headers: Record<string, string> = csrfHeaders,
  ) =>
    server.inject({
      method: "POST",
      url: path(organizationId),
      headers,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      payload: payload as Record<string, unknown>,
    });

  const change = (
    access: string | undefined,
    organizationId: string,
    configurationId: string,
    payload: unknown,
    headers: Record<string, string> = csrfHeaders,
  ) =>
    server.inject({
      method: "PATCH",
      url: path(organizationId, configurationId),
      headers,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      payload: payload as Record<string, unknown>,
    });

  const remove = (
    access: string | undefined,
    organizationId: string,
    configurationId: string,
    headers: Record<string, string> = csrfHeaders,
  ) =>
    server.inject({
      method: "DELETE",
      url: path(organizationId, configurationId),
      headers,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  const read = (access: string | undefined, organizationId: string, configurationId: string) =>
    server.inject({
      method: "GET",
      url: path(organizationId, configurationId),
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  /**
   * Saves a version's YAML. A string payload is sent as it is, JSON already:
   * how a test controls the escaping, and so the body's size.
   */
  const save = (
    access: string | undefined,
    organizationId: string,
    configurationId: string,
    versionId: string,
    payload: unknown,
    headers: Record<string, string> = csrfHeaders,
  ) =>
    server.inject({
      method: "PATCH",
      url: `${path(organizationId, configurationId)}/versions/${versionId}`,
      headers: typeof payload === "string" ? { ...headers, "content-type": "application/json" } : headers,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      payload: payload as Record<string, unknown>,
    });

  /** Reads one version with the configuration and the list. */
  const readVersion = (access: string | undefined, organizationId: string, configurationId: string, versionId: string) =>
    server.inject({
      method: "GET",
      url: `${path(organizationId, configurationId)}/versions/${versionId}`,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  /** Lists a configuration's versions' summaries; `query` from its `?`. */
  const listVersions = (access: string | undefined, organizationId: string, configurationId: string, query = "") =>
    server.inject({
      method: "GET",
      url: `${path(organizationId, configurationId)}/versions${query}`,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  /**
   * Creates a version. A string payload is sent as it is, JSON already, as
   * for a save.
   */
  const newVersion = (
    access: string | undefined,
    organizationId: string,
    configurationId: string,
    payload: unknown,
    headers: Record<string, string> = csrfHeaders,
  ) =>
    server.inject({
      method: "POST",
      url: `${path(organizationId, configurationId)}/versions`,
      headers: typeof payload === "string" ? { ...headers, "content-type": "application/json" } : headers,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      payload: payload as Record<string, unknown>,
    });

  /** Renames a version. */
  const renameVersion = (
    access: string | undefined,
    organizationId: string,
    configurationId: string,
    versionId: string,
    payload: unknown,
    headers: Record<string, string> = csrfHeaders,
  ) =>
    server.inject({
      method: "PUT",
      url: `${path(organizationId, configurationId)}/versions/${versionId}/label`,
      headers,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      payload: payload as Record<string, unknown>,
    });

  /** Records the caller's selected version. */
  const selectVersion = (
    access: string | undefined,
    organizationId: string,
    configurationId: string,
    payload: unknown,
    headers: Record<string, string> = csrfHeaders,
  ) =>
    server.inject({
      method: "PUT",
      url: `${path(organizationId, configurationId)}/selected-version`,
      headers,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      payload: payload as Record<string, unknown>,
    });

  /** Creates one through the API; its body. */
  const created = async (access: string, organizationId: string, name: string, description?: string) => {
    const response = await create(access, organizationId, description === undefined ? { name } : { name, description });
    expect(response.statusCode).toBe(201);
    return response.json<{ configuration: ConfigurationBody }>().configuration;
  };

  const page = async (access: string, organizationId: string, query = "") => {
    const response = await list(access, organizationId, query);
    expect(response.statusCode).toBe(200);
    return response.json<PageBody>();
  };

  const names = (body: PageBody) => body.items.map((item) => item.name);

  const configurationRow = (id: string) =>
    ownerDb.selectFrom("configurations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  const configurationRows = () => ownerDb.selectFrom("configurations").selectAll().orderBy("id").execute();

  const configurationAudits = () =>
    ownerDb
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "like", "configuration.%")
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();

  const versionRows = () => ownerDb.selectFrom("configuration_versions").selectAll().orderBy("id").execute();

  /** A configuration's version 1, as the owner reads it. */
  const versionOf = (configurationId: string) =>
    ownerDb
      .selectFrom("configuration_versions")
      .selectAll()
      .where("configuration_id", "=", configurationId)
      .where("version_number", "=", 1)
      .executeTakeFirstOrThrow();

  const selectionRows = () =>
    ownerDb.selectFrom("configuration_version_selections").selectAll().orderBy("id").execute();

  /** A configuration's version `versionNumber`, as the owner reads it. */
  const versionNumbered = (configurationId: string, versionNumber: number) =>
    ownerDb
      .selectFrom("configuration_versions")
      .selectAll()
      .where("configuration_id", "=", configurationId)
      .where("version_number", "=", versionNumber)
      .executeTakeFirstOrThrow();

  /**
   * Publishes the configuration's version `versionNumber` (1 unless given),
   * as the owner, the way a publish's record writes it: the API's role can
   * only publish through that update. Returns the publish time.
   */
  const publish = async (configurationId: string, versionNumber = 1, publishedByUserId: string | null = null) => {
    const publishedAt = new Date(clock.getTime() - 500);
    const result = await ownerDb
      .updateTable("configuration_versions")
      .set({ published_at: publishedAt, publication_id: randomUUID(), published_by_user_id: publishedByUserId })
      .where("configuration_id", "=", configurationId)
      .where("version_number", "=", versionNumber)
      .executeTakeFirst();
    expect(result.numUpdatedRows).toBe(1n);
    return publishedAt;
  };

  /**
   * Every configuration row, version row, selection row and configuration
   * audit row: what a refusal must leave as it was.
   */
  const snapshot = async () => ({
    rows: await configurationRows(),
    versions: await versionRows(),
    selections: await selectionRows(),
    audits: await configurationAudits(),
  });

  describe("GET …/configurations", () => {
    it("lists newest update first, each with its creator", async () => {
      const { account, organization, access } = await personalUser();
      const first = await created(access, organization.id, "First");
      tick();
      await created(access, organization.id, "Second");
      tick();
      await created(access, organization.id, "Third");
      tick();
      expect((await change(access, organization.id, first.id, { description: "Touched" })).statusCode).toBe(200);

      const body = await page(access, organization.id);

      expect(names(body)).toEqual(["First", "Third", "Second"]);
      expect(body.nextCursor).toBeNull();
      expect(body.items[0]).toEqual({
        id: first.id,
        name: "First",
        description: "Touched",
        createdAt: first.createdAt,
        updatedAt: clock.toISOString(),
        createdBy: { userId: account.user.id, email: account.user.email },
        published: false,
        collectorDistribution: pin.distribution,
      });
    });

    it("answers an empty organization with no items and no cursor", async () => {
      const { organization, access } = await personalUser();
      expect(await page(access, organization.id)).toEqual({ items: [], nextCursor: null });
    });

    it("gives at most limit items, and a cursor when more follow", async () => {
      const { organization, access } = await personalUser();
      for (const name of ["A", "B", "C"]) {
        await created(access, organization.id, name);
        tick();
      }

      const body = await page(access, organization.id, "?limit=2");

      expect(names(body)).toEqual(["C", "B"]);
      expect(body.nextCursor).toEqual(expect.any(String));
    });

    it("walks every configuration exactly once with nextCursor, several created at one clock instant among them", async () => {
      const { organization, access } = await personalUser();
      // Five at one instant (their order is the id's, descending), and one
      // before and one after it.
      await created(access, organization.id, "Before");
      tick();
      for (let index = 0; index < 5; index += 1) await created(access, organization.id, `Same ${index}`);
      tick();
      await created(access, organization.id, "After");
      const expected = await ownerDb
        .selectFrom("configurations")
        .select(["id", "updated_at"])
        .where("organization_id", "=", organization.id)
        .orderBy("updated_at", "desc")
        .orderBy("id", "desc")
        .execute();
      expect(expected).toHaveLength(7);

      const seen: string[] = [];
      const nextCursors: (string | null)[] = [];
      let cursor: string | null = null;
      do {
        const body = await page(
          access,
          organization.id,
          `?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        );
        seen.push(...body.items.map((item) => item.id));
        nextCursors.push(body.nextCursor);
        cursor = body.nextCursor;
      } while (cursor !== null);

      expect(seen).toEqual(expected.map((row) => row.id));
      expect(new Set(seen).size).toBe(7);
      expect(nextCursors).toHaveLength(4);
      expect(nextCursors.at(-1)).toBeNull();
    });

    it("answers the last page's cursor null when it ends exactly on a page boundary", async () => {
      const { organization, access } = await personalUser();
      await created(access, organization.id, "A");
      await created(access, organization.id, "B");
      const first = await page(access, organization.id, "?limit=1");
      expect(first.nextCursor).not.toBeNull();
      const second = await page(access, organization.id, `?limit=1&cursor=${first.nextCursor}`);
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
    });

    it("searches the name and the description, ignoring case, as a substring", async () => {
      const { organization, access } = await personalUser();
      await created(access, organization.id, "Payments Gateway", "Edge collector");
      await created(access, organization.id, "Batch", "Forwards to the GATEWAY");
      await created(access, organization.id, "Unrelated", "Nothing here");

      expect(names(await page(access, organization.id, "?q=gateway")).sort()).toEqual(["Batch", "Payments Gateway"]);
      expect(names(await page(access, organization.id, "?q=%20EDGE%20"))).toEqual(["Payments Gateway"]);
      expect(names(await page(access, organization.id, "?q=nomatch"))).toEqual([]);
      // Empty, after trimming, is no search.
      expect(names(await page(access, organization.id, "?q=%20%20"))).toHaveLength(3);
    });

    it("matches %, _ and \\ in the search as themselves", async () => {
      const { organization, access } = await personalUser();
      await created(access, organization.id, "100% done");
      await created(access, organization.id, "1000 done");
      await created(access, organization.id, "a_b");
      await created(access, organization.id, "axb");

      expect(names(await page(access, organization.id, `?q=${encodeURIComponent("0%")}`))).toEqual(["100% done"]);
      expect(names(await page(access, organization.id, "?q=_"))).toEqual(["a_b"]);
    });

    describe("the filter and drafts' privacy", () => {
      /**
       * A (an admin) and B (a contributor) in one group: A's draft, A's
       * published configuration and B's draft, newest first in that order
       * reversed, so the list reads B's draft, A's published, A's draft.
       */
      const seedFilters = async () => {
        const a = await memberActiveInGroup("admin");
        const b = await memberActiveInGroup("contributor", a.group.id);
        const aDraft = await created(a.access, a.group.id, "A's draft");
        tick();
        const aPublished = await created(a.access, a.group.id, "A's published");
        await publish(aPublished.id, 1, a.account.user.id);
        tick();
        const bDraft = await created(b.access, a.group.id, "B's draft");
        return { a, b, aDraft, aPublished, bDraft };
      };

      it("lists, for all (the default), the caller's own drafts and every published configuration, never another member's draft, whatever the caller's role", async () => {
        const { a, b } = await seedFilters();
        expect(names(await page(b.access, a.group.id))).toEqual(["B's draft", "A's published"]);
        expect(names(await page(b.access, a.group.id, "?filter=all"))).toEqual(["B's draft", "A's published"]);
        // An admin sees no one else's draft either.
        expect(names(await page(a.access, a.group.id, "?filter=all"))).toEqual(["A's published", "A's draft"]);
      });

      it("lists, for mine, only the caller's own, published or not", async () => {
        const { a, b } = await seedFilters();
        expect(names(await page(b.access, a.group.id, "?filter=mine"))).toEqual(["B's draft"]);
        expect(names(await page(a.access, a.group.id, "?filter=mine"))).toEqual(["A's published", "A's draft"]);
      });

      it("lists, for published, every published configuration, whoever's", async () => {
        const { a, b } = await seedFilters();
        expect(names(await page(b.access, a.group.id, "?filter=published"))).toEqual(["A's published"]);
        expect(names(await page(a.access, a.group.id, "?filter=published"))).toEqual(["A's published"]);
      });

      it("says on each item whether it is published", async () => {
        const { a, b, aPublished, bDraft } = await seedFilters();
        const body = await page(b.access, a.group.id);
        expect(body.items.map((item) => [item.id, item.published])).toEqual([
          [bDraft.id, false],
          [aPublished.id, true],
        ]);
      });

      it.each(["all", "mine", "published"] as const)(
        "walks every configuration of filter=%s exactly once with nextCursor, sending the filter with each page (the cursor is positional)",
        async (filter) => {
          const a = await memberActiveInGroup("admin");
          const b = await memberActiveInGroup("contributor", a.group.id);
          const expected: Record<typeof filter, string[]> = { all: [], mine: [], published: [] };
          // Newest last, so the list's order is the reverse.
          for (let index = 0; index < 3; index += 1) {
            const theirs = await created(a.access, a.group.id, `A's published ${index}`);
            await publish(theirs.id);
            await created(a.access, a.group.id, `A's draft ${index}`);
            const mineDraft = await created(b.access, a.group.id, `B's draft ${index}`);
            const minePublished = await created(b.access, a.group.id, `B's published ${index}`);
            await publish(minePublished.id);
            expected.all.unshift(minePublished.name, mineDraft.name, theirs.name);
            expected.mine.unshift(minePublished.name, mineDraft.name);
            expected.published.unshift(minePublished.name, theirs.name);
            tick();
          }

          const seen: string[] = [];
          let cursor: string | null = null;
          do {
            const body: PageBody = await page(
              b.access,
              a.group.id,
              `?limit=2&filter=${filter}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
            );
            seen.push(...names(body));
            cursor = body.nextCursor;
          } while (cursor !== null);
          // The three created in one clock instant are ordered by id, so compare as sets per instant.
          expect(seen).toHaveLength(expected[filter].length);
          expect([...seen].sort()).toEqual([...expected[filter]].sort());
          expect(new Set(seen).size).toBe(seen.length);
        },
      );
    });

    it("leaves deleted configurations out", async () => {
      const { organization, access } = await personalUser();
      await created(access, organization.id, "Kept");
      await addConfiguration(ownerDb, { organizationId: organization.id, name: "Deleted", deleted_at: new Date() });
      expect(names(await page(access, organization.id))).toEqual(["Kept"]);
    });

    it("keeps a soft-deleted creator's email, and has no creator once the account is hard-deleted", async () => {
      const viewer = await memberActiveInGroup("admin");
      // Group members, so their configurations outlive their personal
      // organizations.
      const softly = await verifiedUser();
      await addMembership(ownerDb, { userId: softly.user.id, organizationId: viewer.group.id, role: "contributor" });
      const hard = await verifiedUser();
      await addMembership(ownerDb, { userId: hard.user.id, organizationId: viewer.group.id, role: "contributor" });
      await addConfiguration(ownerDb, {
        organizationId: viewer.group.id,
        name: "Soft",
        created_by_user_id: softly.user.id,
        created_at: clock,
        updated_at: clock,
      });
      await addConfiguration(ownerDb, {
        organizationId: viewer.group.id,
        name: "Hard",
        created_by_user_id: hard.user.id,
        created_at: new Date(clock.getTime() - 1_000),
        updated_at: new Date(clock.getTime() - 1_000),
      });
      // Published, so the viewer sees them.
      for (const configuration of await configurationRows()) {
        await addConfigurationVersion(ownerDb, {
          configurationId: configuration.id,
          organizationId: viewer.group.id,
          publishedAt: clock,
        });
      }
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", softly.user.id).execute();
      await ownerDb.deleteFrom("users").where("id", "=", hard.user.id).execute();

      const body = await page(viewer.access, viewer.group.id);

      expect(body.items.map((item) => [item.name, item.createdBy])).toEqual([
        ["Soft", { userId: softly.user.id, email: softly.user.email }],
        ["Hard", null],
      ]);
    });

    it.each([
      ["limit=0", "?limit=0"],
      ["limit=101", "?limit=101"],
      ["limit=ten", "?limit=ten"],
      ["filter=drafts", "?filter=drafts"],
      ["filter=Mine", "?filter=Mine"],
      ["mine=true, not a filter", "?mine=true"],
      ["cursor=garbage", "?cursor=garbage"],
      [
        "a cursor with a non-UUID id",
        `?cursor=${Buffer.from(JSON.stringify({ updatedAt: new Date().toISOString(), id: "42" })).toString("base64url")}`,
      ],
      ["a cursor over 256 characters", `?cursor=${"a".repeat(257)}`],
      ["a search over 200 characters", `?q=${"a".repeat(201)}`],
      ["an unknown parameter", "?unknown=1"],
      ["a repeated parameter", "?q=a&q=b"],
    ])("refuses %s with 400 invalid_request", async (_label, query) => {
      const { organization, access } = await personalUser();
      expectInvalid(await list(access, organization.id, query));
    });

    it("accepts limits 1 and 100", async () => {
      const { organization, access } = await personalUser();
      expect((await list(access, organization.id, "?limit=1")).statusCode).toBe(200);
      expect((await list(access, organization.id, "?limit=100")).statusCode).toBe(200);
    });

    it("keeps the search text out of the API's log", async () => {
      const { organization, access } = await personalUser();
      const secret = "Quarterly-payroll-pipeline";

      expect((await list(access, organization.id, `?q=${secret}&filter=mine`)).statusCode).toBe(200);
      // A trailing slash matches no route, and is still left out.
      expect((await list(access, organization.id, `/?q=${secret}`)).statusCode).toBe(404);

      const requestLines = logLines.filter((line) =>
        line.includes(`/api/v1/organizations/${organization.id}/configurations`),
      );
      expect(requestLines.length).toBeGreaterThan(0);
      expect(logLines.filter((line) => line.includes(secret))).toEqual([]);
    });
  });

  describe("POST …/configurations", () => {
    it("creates one: 201, the caller as creator, both timestamps the clock's, and its audit row", async () => {
      const { account, organization, access } = await personalUser();

      const response = await create(access, organization.id, { name: "Gateway", description: "Edge collector" });

      expect(response.statusCode).toBe(201);
      const { configuration } = response.json<{ configuration: ConfigurationBody }>();
      expect(configuration).toEqual({
        id: expect.any(String),
        name: "Gateway",
        description: "Edge collector",
        createdAt: clock.toISOString(),
        updatedAt: clock.toISOString(),
        createdBy: { userId: account.user.id, email: account.user.email },
        // Its version 1 is empty and unpublished: a draft.
        published: false,
        collectorDistribution: pin.distribution,
      });
      expect(await configurationRow(configuration.id)).toMatchObject({
        organization_id: organization.id,
        created_by_user_id: account.user.id,
        created_at: clock,
        updated_at: clock,
        deleted_at: null,
        // The catalog's default distribution, read from its table.
        collector_distribution: pin.distribution,
      });
      expect(await configurationAudits()).toEqual([
        expect.objectContaining({
          action: "configuration.created",
          actor_user_id: account.user.id,
          actor_email: account.user.email,
          organization_id: organization.id,
          subject_type: "configuration",
          subject_id: configuration.id,
          metadata: { name: "Gateway" },
          ip_address: expect.any(String),
          user_agent: expect.any(String),
        }),
      ]);
      // The creator lists it.
      expect((await page(access, organization.id)).items).toEqual([configuration]);
    });

    it("trims the name and the description", async () => {
      const { organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "  Gateway  ", "  Edge  ");
      expect(configuration).toMatchObject({ name: "Gateway", description: "Edge" });
    });

    it("makes a description left out ''", async () => {
      const { organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "Gateway");
      expect(configuration.description).toBe("");
      expect((await configurationRow(configuration.id)).description).toBe("");
    });

    it("allows two configurations with one name", async () => {
      const { organization, access } = await personalUser();
      await created(access, organization.id, "Twin");
      await created(access, organization.id, "Twin");
      expect(names(await page(access, organization.id))).toEqual(["Twin", "Twin"]);
    });

    it("creates exactly one version with it: number 1, '', unnamed, created by the caller, both timestamps the clock's, the graph '[]', and pinned to the catalog's default version of its distribution", async () => {
      const { account, organization, access } = await personalUser();

      const configuration = await created(access, organization.id, "Gateway");

      expect(await versionRows()).toEqual([
        {
          id: expect.any(String),
          configuration_id: configuration.id,
          organization_id: organization.id,
          version_number: 1,
          yaml_content: "",
          label: null,
          created_by_user_id: account.user.id,
          created_at: clock,
          updated_at: clock,
          nodes: [],
          edges: [],
          pipelines: [],
          // A new version is a draft.
          published_at: null,
          published_by_user_id: null,
          publication_id: null,
          collector_distribution: pin.distribution,
          collector_version: pin.version,
        },
      ]);
    });

    it("leaves no configuration behind when the version's insert fails", async () => {
      const { organization, access } = await personalUser();
      const before = await snapshot();

      await withFailingInsert(ownerDb, "configuration_versions", "raise exception 'version insert refused'", async () => {
        const response = await create(access, organization.id, { name: "Doomed" });
        expect(response.statusCode).toBe(500);
      });

      expect(await snapshot()).toEqual(before);
      expect(await page(access, organization.id)).toEqual({ items: [], nextCursor: null });
    });
  });

  describe("POST …/configurations from a flow", () => {
    const VERSION_UNKNOWN = ["collector_version_unknown", "That collector version isn't available."] as const;
    const DISTRIBUTION_UNKNOWN = ["collector_distribution_unknown", "That collector distribution isn't available."] as const;

    /** A seeded flow as its migration holds it. */
    const seededFlow = async (slug: string) => {
      const seededFlows = await loadSeededFlows();
      const flow = seededFlows.find((candidate) => candidate.slug === slug);
      if (!flow) throw new Error(`no seeded flow ${slug}`);
      return flow;
    };

    /** A version of the default distribution the catalog has deprecated. */
    const deprecatedVersion = async () =>
      (
        await ownerDb
          .selectFrom("collector_versions")
          .select("version")
          .where("distribution", "=", pin.distribution)
          .where("deprecated", "=", true)
          .orderBy("version")
          .executeTakeFirstOrThrow()
      ).version;

    /** A flow's text: a trailing newline and an env reference, as every seeded flow has. */
    const FLOW_YAML = "exporters:\n  otlp:\n    endpoint: ${env:OTLP_ENDPOINT}\n";

    /** What the web sends for a flow: the text, the stored graph, the pin and the slug. */
    const fromFlow = (overrides: Record<string, unknown> = {}) => ({
      name: "PII Redaction Gateway",
      yamlContent: FLOW_YAML,
      ...GRAPH,
      collectorDistribution: pin.distribution,
      collectorVersion: otherVersion,
      sourceFlowSlug: "pii-redaction-gateway",
      ...overrides,
    });

    it("creates from a seeded flow: version 1 holds its YAML byte for byte and the graph as sent, at the flow's pin; the slug is on the row and in no answer; the audit row names only the name", async () => {
      const flow = await seededFlow("clickhouse-failover-gateway-s3-overflow");
      // What makes this test mean something: a trailing newline, an env
      // reference, and a pin that is offered but not the default.
      expect(flow.yaml_content.endsWith("\n")).toBe(true);
      expect(flow.yaml_content).toContain("${env:");
      expect(flow.yaml_content).not.toContain(flow.slug);
      expect(flow.collector_distribution).toBe(pin.distribution);
      expect(flow.collector_version).not.toBe(pin.version);
      expect(
        await ownerDb
          .selectFrom("collector_versions")
          .select("deprecated")
          .where("distribution", "=", flow.collector_distribution)
          .where("version", "=", flow.collector_version)
          .executeTakeFirstOrThrow(),
      ).toEqual({ deprecated: false });
      const { account, organization, access } = await personalUser();

      const response = await create(access, organization.id, {
        name: flow.name,
        description: flow.summary,
        yamlContent: flow.yaml_content,
        ...GRAPH,
        collectorDistribution: flow.collector_distribution,
        collectorVersion: flow.collector_version,
        sourceFlowSlug: flow.slug,
      });

      expect(response.statusCode).toBe(201);
      const { configuration } = response.json<{ configuration: ConfigurationBody }>();
      // The answer is a configuration's, exactly: no slug, no content.
      expect(configuration).toEqual({
        id: expect.any(String),
        name: flow.name,
        description: flow.summary,
        createdAt: clock.toISOString(),
        updatedAt: clock.toISOString(),
        createdBy: { userId: account.user.id, email: account.user.email },
        published: false,
        collectorDistribution: flow.collector_distribution,
      });
      expect(await configurationRow(configuration.id)).toMatchObject({
        source_flow_slug: flow.slug,
        collector_distribution: flow.collector_distribution,
      });
      expect(await versionRows()).toEqual([
        {
          id: expect.any(String),
          configuration_id: configuration.id,
          organization_id: organization.id,
          version_number: 1,
          yaml_content: flow.yaml_content,
          label: null,
          created_by_user_id: account.user.id,
          created_at: clock,
          updated_at: clock,
          nodes: GRAPH.nodes,
          edges: GRAPH.edges,
          pipelines: GRAPH.pipelines,
          published_at: null,
          published_by_user_id: null,
          publication_id: null,
          collector_distribution: flow.collector_distribution,
          collector_version: flow.collector_version,
        },
      ]);
      const row = await versionOf(configuration.id);
      // Byte for byte: the same string, so the same UTF-8 bytes.
      expect(row.yaml_content).toBe(flow.yaml_content);
      expect(Buffer.from(row.yaml_content, "utf8").equals(Buffer.from(flow.yaml_content, "utf8"))).toBe(true);
      // The editor opens it as sent.
      const opened = await read(access, organization.id, configuration.id);
      expect(opened.statusCode).toBe(200);
      expect(opened.json<WithVersionBody>().version).toMatchObject({
        yamlContent: flow.yaml_content,
        ...GRAPH,
        collectorVersion: flow.collector_version,
        collectorVersionDeprecated: false,
      });
      // Nothing about the slug in any answer: the create, the read, a version's read, the list.
      const answers = [
        response,
        opened,
        await readVersion(access, organization.id, configuration.id, row.id),
        await list(access, organization.id),
      ];
      for (const answer of answers) {
        expect(answer.statusCode).toBeLessThan(300);
        for (const text of [flow.slug, "sourceFlowSlug", "source_flow_slug", "FlowSlug"]) {
          expect(answer.body).not.toContain(text);
        }
      }
      // The audit row as before: the name alone, never the text, the graph or the slug.
      expect((await configurationAudits()).map((audit) => audit.metadata)).toEqual([{ name: flow.name }]);
    });

    it("creates from every seeded flow at its pin, the later migrations' included: each answers 201 and its version 1 holds the flow's YAML byte for byte at that pin", async () => {
      const seededFlows = await loadSeededFlows();
      expect(seededFlows).toHaveLength(20);
      const { organization, access } = await personalUser();

      for (const flow of seededFlows) {
        const response = await create(access, organization.id, {
          name: flow.name,
          description: flow.summary,
          yamlContent: flow.yaml_content,
          ...GRAPH,
          collectorDistribution: flow.collector_distribution,
          collectorVersion: flow.collector_version,
          sourceFlowSlug: flow.slug,
        });
        expect({ slug: flow.slug, status: response.statusCode }).toEqual({ slug: flow.slug, status: 201 });
        const row = await versionOf(response.json<{ configuration: ConfigurationBody }>().configuration.id);
        expect({ slug: flow.slug, yaml: row.yaml_content, version: row.collector_version }).toEqual({
          slug: flow.slug,
          yaml: flow.yaml_content,
          version: flow.collector_version,
        });
      }
    });

    it.each([
      ["a trailing newline and an env reference", FLOW_YAML],
      ["CRLF line endings and trailing blank lines", "receivers:\r\n  otlp:\r\n    protocols: {}\r\n\r\n"],
      ["leading whitespace and $${env:X}, the escaped form", "\n\t  receivers: {} # $${env:X} ${env:X:-default}\n"],
      ["a non-BMP character", "# 🚀 𝕏\nreceivers: {}\n"],
      ["''", ""],
    ])("stores %s exactly as sent", async (_label, yamlContent) => {
      const { organization, access } = await personalUser();
      const response = await create(access, organization.id, fromFlow({ yamlContent }));
      expect(response.statusCode).toBe(201);
      const { configuration } = response.json<{ configuration: ConfigurationBody }>();
      expect((await versionOf(configuration.id)).yaml_content).toBe(yamlContent);
    });

    it("refuses every proper subset of the content's four fields: 400 invalid_request, creating nothing", async () => {
      const { organization, access } = await personalUser();
      const content = { yamlContent: FLOW_YAML, ...GRAPH };
      const fields = ["yamlContent", "nodes", "edges", "pipelines"] as const;
      const before = await snapshot();
      let refused = 0;
      for (let mask = 1; mask < 2 ** fields.length - 1; mask += 1) {
        const subset = fields.filter((_field, bit) => (mask & (1 << bit)) !== 0);
        const payload = { name: "Partial", ...Object.fromEntries(subset.map((field) => [field, content[field]])) };
        expectInvalid(await create(access, organization.id, payload));
        refused += 1;
      }
      expect(refused).toBe(14);
      expect(await snapshot()).toEqual(before);
      // The four together are accepted.
      expect((await create(access, organization.id, { name: "Whole", ...content })).statusCode).toBe(201);
    });

    describe("its collector version", () => {
      it("stores a version the distribution offers that isn't its default", async () => {
        const { organization, access } = await personalUser();
        expect(otherVersion).not.toBe(pin.version);

        const response = await create(access, organization.id, fromFlow());

        expect(response.statusCode).toBe(201);
        const { configuration } = response.json<{ configuration: ConfigurationBody }>();
        expect(await versionOf(configuration.id)).toMatchObject({
          collector_distribution: pin.distribution,
          collector_version: otherVersion,
        });
      });

      it("checks one sent with no distribution against the catalog's default distribution, and builds for it", async () => {
        const { organization, access } = await personalUser();
        const { collectorDistribution: _left, ...withoutDistribution } = fromFlow();

        const response = await create(access, organization.id, withoutDistribution);

        expect(response.statusCode).toBe(201);
        const { configuration } = response.json<{ configuration: ConfigurationBody }>();
        expect(configuration.collectorDistribution).toBe(pin.distribution);
        expect(await versionOf(configuration.id)).toMatchObject({
          collector_distribution: pin.distribution,
          collector_version: otherVersion,
        });
        // And refuses a deprecated one of the default distribution the same way.
        const before = await snapshot();
        expectRefusal(
          await create(access, organization.id, { ...withoutDistribution, collectorVersion: await deprecatedVersion() }),
          400,
          ...VERSION_UNKNOWN,
        );
        expect(await snapshot()).toEqual(before);
      });

      it("takes the default given again, and one sent without any content (version 1 then '' and an empty graph)", async () => {
        const { organization, access } = await personalUser();
        const atDefault = await create(access, organization.id, fromFlow({ collectorVersion: pin.version }));
        expect(atDefault.statusCode).toBe(201);
        expect(await versionOf(atDefault.json<{ configuration: ConfigurationBody }>().configuration.id)).toMatchObject({
          collector_version: pin.version,
        });

        const bare = await create(access, organization.id, { name: "Bare", collectorVersion: otherVersion });
        expect(bare.statusCode).toBe(201);
        expect(await versionOf(bare.json<{ configuration: ConfigurationBody }>().configuration.id)).toMatchObject({
          yaml_content: "",
          nodes: [],
          edges: [],
          pipelines: [],
          collector_version: otherVersion,
        });
      });

      it("refuses a deprecated version: 400 collector_version_unknown, creating and auditing nothing", async () => {
        const { organization, access } = await personalUser();
        const before = await snapshot();
        expectRefusal(
          await create(access, organization.id, fromFlow({ collectorVersion: await deprecatedVersion() })),
          400,
          ...VERSION_UNKNOWN,
        );
        expect(await snapshot()).toEqual(before);
      });

      it("refuses a version the catalog doesn't have: 400 collector_version_unknown, creating and auditing nothing", async () => {
        const { organization, access } = await personalUser();
        const before = await snapshot();
        expectRefusal(await create(access, organization.id, fromFlow({ collectorVersion: "9.9.9" })), 400, ...VERSION_UNKNOWN);
        expect(await snapshot()).toEqual(before);
      });

      it("refuses an unknown distribution first: 400 collector_distribution_unknown, whatever the version", async () => {
        const { organization, access } = await personalUser();
        const before = await snapshot();
        expectRefusal(
          await create(access, organization.id, fromFlow({ collectorDistribution: "clickstack", collectorVersion: "9.9.9" })),
          400,
          ...DISTRIBUTION_UNKNOWN,
        );
        expect(await snapshot()).toEqual(before);
      });

      it("refuses a version that isn't in the catalog's format: 400 invalid_request", async () => {
        const { organization, access } = await personalUser();
        const before = await snapshot();
        expectInvalid(await create(access, organization.id, fromFlow({ collectorVersion: "v0.162.0" })));
        expect(await snapshot()).toEqual(before);
      });
    });

    describe("its slug (the format only)", () => {
      it("stores a slug no flow has, and one sent alone, without content", async () => {
        const { organization, access } = await personalUser();
        const unknown = await create(access, organization.id, fromFlow({ sourceFlowSlug: "no-such-flow" }));
        expect(unknown.statusCode).toBe(201);
        const alone = await create(access, organization.id, { name: "Alone", sourceFlowSlug: "a".repeat(80) });
        expect(alone.statusCode).toBe(201);
        expect(
          await configurationRow(unknown.json<{ configuration: ConfigurationBody }>().configuration.id),
        ).toMatchObject({ source_flow_slug: "no-such-flow" });
        expect(await configurationRow(alone.json<{ configuration: ConfigurationBody }>().configuration.id)).toMatchObject({
          source_flow_slug: "a".repeat(80),
        });
      });

      it("leaves it null on a create without one", async () => {
        const { organization, access } = await personalUser();
        const configuration = await created(access, organization.id, "Blank");
        expect(await configurationRow(configuration.id)).toMatchObject({ source_flow_slug: null });
      });

      it.each([
        ["upper case", "PII-Redaction"],
        ["a space", "pii redaction"],
        ["surrounding whitespace", " pii "],
        ["''", ""],
        ["81 characters", "a".repeat(81)],
        ["null", null],
      ])("refuses one with %s: 400 invalid_request, creating nothing", async (_label, sourceFlowSlug) => {
        const { organization, access } = await personalUser();
        const before = await snapshot();
        expectInvalid(await create(access, organization.id, fromFlow({ sourceFlowSlug })));
        expect(await snapshot()).toEqual(before);
      });
    });

    describe("its content's limits, as the save's", () => {
      /** A config string that makes the nodes column `bytes` long in UTF-8, in `unit`s. */
      const nodesOfBytes = (bytes: number, unit: string) => {
        const empty = Buffer.byteLength(JSON.stringify(graphWithReceiver((node) => (node.data.config = "")).nodes));
        const count = Math.floor((bytes - empty) / Buffer.byteLength(unit));
        return graphWithReceiver((node) => (node.data.config = unit.repeat(count)));
      };

      it.each([
        ["262,145 characters of YAML", () => ({ ...GRAPH, yamlContent: "a".repeat(262_145) })],
        ["U+0000 in the YAML", () => ({ ...GRAPH, yamlContent: "receivers:\u0000" })],
        ["a lone surrogate in the YAML", () => ({ ...GRAPH, yamlContent: "receivers: \ud83d" })],
        ["a component id carrying a name", () => graphWithReceiver((node) => (node.id = "receiver-otlp-1"))],
        ["React Flow's measured", () => graphWithReceiver((node) => (node.measured = { width: 10, height: 10 }))],
        ["a position beyond ±1,000,000", () => graphWithReceiver((node) => (node.position.x = 1_000_001))],
        [
          "5,001 nodes",
          () => ({ ...GRAPH, nodes: Array.from({ length: 5_001 }, (_, index) => ({ ...RECEIVER, id: `node_${index}` })) }),
        ],
        ["a nodes column one byte over 1 MiB", () => nodesOfBytes(GRAPH_COLUMN_BYTES + 1, "a")],
        [
          "U+0000 in a nested config string",
          () => graphWithReceiver((node) => (node.data.config = { a: [{ b: "x\u0000y" }] })),
        ],
        ["nodes as an object", () => ({ ...GRAPH, nodes: {} })],
        ["pipelines as null", () => ({ ...GRAPH, pipelines: null })],
      ])("refuses %s: 400 invalid_request, creating nothing", async (_label, contentOf) => {
        const { organization, access } = await personalUser();
        const before = await snapshot();
        expectInvalid(await create(access, organization.id, { ...fromFlow(), ...contentOf() }));
        expect(await snapshot()).toEqual(before);
      });

      it("accepts a create at the contract's bounds, about 4.4 MiB of JSON: the versions' 5 MiB applies", async () => {
        const { organization, access } = await personalUser();
        const payload = { ...fromFlow(), ...maximalSave(), name: "n".repeat(200), description: "d".repeat(500), sourceFlowSlug: "s".repeat(80) };
        expect(Buffer.byteLength(JSON.stringify(payload.nodes))).toBe(GRAPH_COLUMN_BYTES);
        const body = JSON.stringify(payload);
        expect(Buffer.byteLength(body)).toBeGreaterThan(4.3 * 1_048_576);
        expect(Buffer.byteLength(body)).toBeLessThan(SAVE_BODY_LIMIT);

        const response = await create(access, organization.id, body, { ...csrfHeaders, "content-type": "application/json" });

        expect(response.statusCode).toBe(201);
        const row = await versionOf(response.json<{ configuration: ConfigurationBody }>().configuration.id);
        expect(row.yaml_content).toBe(payload.yamlContent);
        expect(row.nodes).toHaveLength(5_000);
        expect(row.edges).toEqual(payload.edges);
        expect(row.pipelines).toEqual(payload.pipelines);
      });

      it("accepts a body of exactly 5,242,880 bytes, and answers one byte more 413 payload_too_large, creating nothing", async () => {
        const { organization, access } = await personalUser();
        const json = JSON.stringify(fromFlow({ yamlContent: "at the limit\n" }));
        const atLimit = `${json}${" ".repeat(SAVE_BODY_LIMIT - Buffer.byteLength(json))}`;
        expect(Buffer.byteLength(atLimit)).toBe(5_242_880);
        const headers = { ...csrfHeaders, "content-type": "application/json" };

        const before = await snapshot();
        expectRefusal(await create(access, organization.id, `${atLimit} `, headers), 413, "payload_too_large", MESSAGES.tooLarge);
        expect(await snapshot()).toEqual(before);

        const response = await create(access, organization.id, atLimit, headers);
        expect(response.statusCode).toBe(201);
        expect(await versionOf(response.json<{ configuration: ConfigurationBody }>().configuration.id)).toMatchObject({
          yaml_content: "at the limit\n",
          ...GRAPH,
        });
      });

      it("answers 400 invalid_request, not 500, when the table's backstop refuses a graph the contract allowed, creating nothing", async () => {
        const { organization, access } = await personalUser();
        const marker = `Private-label-${randomUUID()}`;
        // 20,000 × 1e300: about 140 KB of JSON, well within the contract, and
        // about 6 MB of jsonb::text, over the 4 MiB check.
        const graph = graphWithReceiver((receiver) => {
          receiver.data.label = marker;
          receiver.data.config = Array.from({ length: 20_000 }, () => 1e300);
        });
        expect(Buffer.byteLength(JSON.stringify(graph.nodes))).toBeLessThan(GRAPH_COLUMN_BYTES / 4);
        const before = await snapshot();

        const response = await create(access, organization.id, fromFlow(graph));

        expectRefusal(response, 400, "invalid_request", MESSAGES.invalid);
        expect(response.body).not.toContain(marker);
        expect(await snapshot()).toEqual(before);
        // The database's error, whose detail holds the row, is logged nowhere.
        expect(logLines.filter((line) => line.includes(marker) || line.includes("check constraint"))).toEqual([]);
      });
    });

    it("keeps the flow's YAML and graph out of the API's log and the audit row, whatever the answer, and out of every refusal's body", async () => {
      const { organization, access } = await personalUser();
      const marker = `Private-yaml-${randomUUID()}`;
      const yamlContent = `exporters:\n  otlp:\n    headers: { authorization: ${marker} }\n`;
      const graph = graphWithReceiver((receiver) => {
        receiver.data.label = marker;
        receiver.data.config = { headers: { authorization: marker } };
      });

      const answers = [
        await create(access, organization.id, fromFlow({ yamlContent, ...graph })),
        await create(access, organization.id, fromFlow({ yamlContent, ...graph, collectorVersion: "9.9.9" })),
        await create(access, organization.id, fromFlow({ yamlContent, ...graph, pipelines: undefined })),
        await create(access, organization.id, fromFlow({ yamlContent, ...graph, nodes: [{ ...graph.nodes[1], measured: {} }] })),
      ];

      expect(answers.map((answer) => answer.statusCode)).toEqual([201, 400, 400, 400]);
      for (const answer of answers) expect(answer.body).not.toContain(marker);
      const audited = JSON.stringify(await configurationAudits());
      for (const secret of [marker, "exporters", "node_0", "pipeline_0"]) expect(audited).not.toContain(secret);
      expect(logLines.filter((line) => line.includes("/configurations")).length).toBeGreaterThan(0);
      expect(logLines.filter((line) => line.includes(marker))).toEqual([]);
    });
  });

  describe("GET …/configurations/:configurationId", () => {
    it("answers the configuration and its version 1, with its YAML", async () => {
      const { account, organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "Gateway", "Edge collector");
      const version = await versionOf(configuration.id);

      const response = await read(access, organization.id, configuration.id);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        configuration: {
          id: configuration.id,
          name: "Gateway",
          description: "Edge collector",
          createdAt: clock.toISOString(),
          updatedAt: clock.toISOString(),
          createdBy: { userId: account.user.id, email: account.user.email },
          published: false,
          collectorDistribution: pin.distribution,
        },
        version: {
          id: version.id,
          configurationId: configuration.id,
          versionNumber: 1,
          label: null,
          createdBy: { userId: account.user.id, email: account.user.email },
          yamlContent: "",
          nodes: [],
          edges: [],
          pipelines: [],
          createdAt: clock.toISOString(),
          updatedAt: clock.toISOString(),
          publishedAt: null,
          publishedBy: null,
          ...pinned,
        },
        versions: [
          {
            id: version.id,
            versionNumber: 1,
            label: null,
            createdBy: { userId: account.user.id, email: account.user.email },
            createdAt: clock.toISOString(),
            updatedAt: clock.toISOString(),
            publishedAt: null,
            publishedBy: null,
            ...pinned,
          },
        ],
      });
    });

    it("answers a published configuration's flag, and its published version's time and publisher", async () => {
      const { account, organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "Gateway");
      const publishedAt = await publish(configuration.id, 1, account.user.id);

      const body = (await read(access, organization.id, configuration.id)).json<WithVersionBody>();

      expect(body.configuration.published).toBe(true);
      expect(body.version).toMatchObject({
        publishedAt: publishedAt.toISOString(),
        publishedBy: { userId: account.user.id, email: account.user.email },
        ...pinned,
      });
      expect(body.versions[0]).toMatchObject({
        publishedAt: publishedAt.toISOString(),
        publishedBy: { userId: account.user.id, email: account.user.email },
        ...pinned,
      });
    });

    it("answers a soft-deleted publisher's email, and no publisher once the account is hard-deleted", async () => {
      const viewer = await memberActiveInGroup("admin");
      const softly = await verifiedUser();
      await addMembership(ownerDb, { userId: softly.user.id, organizationId: viewer.group.id, role: "contributor" });
      const hard = await verifiedUser();
      await addMembership(ownerDb, { userId: hard.user.id, organizationId: viewer.group.id, role: "contributor" });
      const configuration = await created(viewer.access, viewer.group.id, "Gateway");
      await publish(configuration.id, 1, softly.user.id);
      await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: viewer.group.id,
        version_number: 2,
        publishedAt: clock,
        publishedByUserId: hard.user.id,
      });
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", softly.user.id).execute();
      await ownerDb.deleteFrom("users").where("id", "=", hard.user.id).execute();

      const body = (await read(viewer.access, viewer.group.id, configuration.id)).json<WithVersionBody>();

      expect(body.versions.map((version) => [version.versionNumber, version.publishedBy])).toEqual([
        [2, null],
        [1, { userId: softly.user.id, email: softly.user.email }],
      ]);
      expect(body.versions.every((version) => version.publishedAt !== null)).toBe(true);
    });

    it("tells every cache to keep no copy: the YAML can hold secrets", async () => {
      const { organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "Gateway");

      const response = await read(access, organization.id, configuration.id);

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("answers a version's YAML as it is stored", async () => {
      const { account, organization, access } = await personalUser();
      const configuration = await addConfiguration(ownerDb, {
        organizationId: organization.id,
        name: "Seeded",
        created_by_user_id: account.user.id,
      });
      const yaml = "receivers:\r\n  otlp: {}  \n# 🚀\n";
      await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: organization.id,
        yaml_content: yaml,
      });

      const response = await read(access, organization.id, configuration.id);

      expect(response.statusCode).toBe(200);
      expect(response.json<{ version: VersionBody }>().version.yamlContent).toBe(yaml);
    });

    it("answers the saved YAML after a save", async () => {
      const { organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "Gateway");
      const version = await versionOf(configuration.id);
      expect(
        (
          await save(access, organization.id, configuration.id, version.id, {
            yamlContent: "exporters: {}\n",
            ...EMPTY_GRAPH,
          })
        ).statusCode,
      ).toBe(200);

      const response = await read(access, organization.id, configuration.id);

      expect(response.json<{ version: VersionBody }>().version).toMatchObject({
        id: version.id,
        yamlContent: "exporters: {}\n",
      });
    });

    it("lets another member read the creator's published configuration", async () => {
      const creator = await memberActiveInGroup("admin");
      const other = await memberActiveInGroup("contributor", creator.group.id);
      const configuration = await created(creator.access, creator.group.id, "Theirs");
      await publish(configuration.id);

      const response = await read(other.access, creator.group.id, configuration.id);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        configuration: { id: configuration.id, published: true },
        version: { versionNumber: 1 },
      });
    });

    it("answers an unknown and a deleted configuration 404 configuration_not_found", async () => {
      const { organization, access } = await personalUser();
      const deleted = await created(access, organization.id, "Doomed");
      expect((await remove(access, organization.id, deleted.id)).statusCode).toBe(204);

      for (const id of [randomUUID(), deleted.id]) {
        expectRefusal(
          await read(access, organization.id, id),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
      }
    });

    it.each(["not-a-uuid", "42", "0192F1A47B3C7D2E8F101A2B3C4D5E6F", "%7B0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f%7D"])(
      "answers a malformed configuration id (%s) 404 configuration_not_found",
      async (id) => {
        const { organization, access } = await personalUser();
        await created(access, organization.id, "Present");
        expectRefusal(
          await read(access, organization.id, id),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
      },
    );

    describe("which version it opens", () => {
      /**
       * A group with two members: A created the configuration (version 1)
       * and published version 1, so B sees it; B created version 2 with a
       * label, and A version 3.
       */
      const threeVersions = async () => {
        const a = await memberActiveInGroup("admin");
        const b = await memberActiveInGroup("contributor", a.group.id);
        const configuration = await created(a.access, a.group.id, "Gateway");
        const firstPublishedAt = await publish(configuration.id, 1, a.account.user.id);
        const first = await versionOf(configuration.id);
        tick();
        const second = await newVersion(b.access, a.group.id, configuration.id, {
          sourceVersionId: first.id,
          label: "B's",
          yamlContent: "second\n",
          ...EMPTY_GRAPH,
        });
        expect(second.statusCode).toBe(201);
        tick();
        const third = await newVersion(a.access, a.group.id, configuration.id, {
          sourceVersionId: first.id,
          yamlContent: "third\n",
          ...EMPTY_GRAPH,
        });
        expect(third.statusCode).toBe(201);
        tick();
        return {
          a,
          b,
          group: a.group,
          configuration,
          first,
          firstPublishedAt,
          second: second.json<{ version: VersionBody }>().version,
          third: third.json<{ version: VersionBody }>().version,
        };
      };

      const opened = async (access: string, organizationId: string, configurationId: string) => {
        const response = await read(access, organizationId, configurationId);
        expect(response.statusCode).toBe(200);
        return response.json<WithVersionBody>();
      };

      it("opens the highest when the caller has no selection, and lists every version highest first, each with its creator", async () => {
        const { a, b, group, configuration, first, firstPublishedAt, second, third } = await threeVersions();

        const body = await opened(a.access, group.id, configuration.id);

        expect(body.version).toEqual(third);
        expect(body.versions).toEqual([
          {
            id: third.id,
            versionNumber: 3,
            label: null,
            createdBy: { userId: a.account.user.id, email: a.account.user.email },
            createdAt: third.createdAt,
            updatedAt: third.updatedAt,
            publishedAt: null,
            publishedBy: null,
            ...pinned,
          },
          {
            id: second.id,
            versionNumber: 2,
            label: "B's",
            createdBy: { userId: b.account.user.id, email: b.account.user.email },
            createdAt: second.createdAt,
            updatedAt: second.updatedAt,
            publishedAt: null,
            publishedBy: null,
            ...pinned,
          },
          {
            id: first.id,
            versionNumber: 1,
            label: null,
            createdBy: { userId: a.account.user.id, email: a.account.user.email },
            createdAt: first.created_at.toISOString(),
            updatedAt: first.updated_at.toISOString(),
            publishedAt: firstPublishedAt.toISOString(),
            publishedBy: { userId: a.account.user.id, email: a.account.user.email },
            ...pinned,
          },
        ]);
      });

      it("opens the caller's selection after one, though higher versions exist", async () => {
        const { a, group, configuration, first, third } = await threeVersions();

        expect((await selectVersion(a.access, group.id, configuration.id, { versionId: first.id })).statusCode).toBe(204);
        const body = await opened(a.access, group.id, configuration.id);

        expect(body.version).toMatchObject({ id: first.id, versionNumber: 1, yamlContent: "" });
        // The list is the same whichever version opens.
        expect(body.versions.map((version) => version.versionNumber)).toEqual([3, 2, 1]);
        expect(body.versions[0]!.id).toBe(third.id);
      });

      it("never lets another member's selection change what this member gets", async () => {
        const { a, b, group, configuration, first, second, third } = await threeVersions();

        expect((await selectVersion(b.access, group.id, configuration.id, { versionId: first.id })).statusCode).toBe(204);
        expect((await opened(a.access, group.id, configuration.id)).version.id).toBe(third.id);
        expect((await opened(b.access, group.id, configuration.id)).version.id).toBe(first.id);

        expect((await selectVersion(a.access, group.id, configuration.id, { versionId: second.id })).statusCode).toBe(
          204,
        );
        expect((await opened(a.access, group.id, configuration.id)).version.id).toBe(second.id);
        expect((await opened(b.access, group.id, configuration.id)).version.id).toBe(first.id);
      });

      it("keeps a soft-deleted creator's email in the list, and has no creator once the account is hard-deleted", async () => {
        const viewer = await memberActiveInGroup("admin");
        const softly = await verifiedUser();
        await addMembership(ownerDb, { userId: softly.user.id, organizationId: viewer.group.id, role: "contributor" });
        const hard = await verifiedUser();
        await addMembership(ownerDb, { userId: hard.user.id, organizationId: viewer.group.id, role: "contributor" });
        const configuration = await addConfiguration(ownerDb, { organizationId: viewer.group.id, name: "Seeded" });
        for (const [versionNumber, creator] of [
          [1, softly.user.id],
          [2, hard.user.id],
        ] as const) {
          await addConfigurationVersion(ownerDb, {
            configurationId: configuration.id,
            organizationId: viewer.group.id,
            version_number: versionNumber,
            created_by_user_id: creator,
            // Version 1 published: an authorless configuration is visible
            // only once published.
            ...(versionNumber === 1 ? { publishedAt: clock } : {}),
          });
        }
        await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", softly.user.id).execute();
        await ownerDb.deleteFrom("users").where("id", "=", hard.user.id).execute();

        const body = await opened(viewer.access, viewer.group.id, configuration.id);

        expect(body.version.createdBy).toBeNull();
        expect(body.versions.map((version) => [version.versionNumber, version.createdBy])).toEqual([
          [2, null],
          [1, { userId: softly.user.id, email: softly.user.email }],
        ]);
      });
    });
  });

  describe("PATCH …/configurations/:configurationId/versions/:versionId", () => {
    const withVersion = async () => {
      const user = await personalUser();
      const configuration = await created(user.access, user.organization.id, "Gateway");
      const version = await versionOf(configuration.id);
      tick();
      return { ...user, configuration, version };
    };

    it.each([
      ["CRLF line endings", "receivers:\r\n  otlp:\r\n    protocols: {}\r\n"],
      ["a trailing newline, and trailing spaces", "receivers: {}   \n\n"],
      ["leading whitespace", "\n\t  receivers: {}"],
      ["''", ""],
      ["a non-BMP character", "# 🚀 𝕏\nreceivers: {}\n"],
    ])("saves %s exactly as sent: 200 with the version, updatedAt the clock's", async (_label, yamlContent) => {
      const { account, organization, access, configuration, version } = await withVersion();

      const response = await save(access, organization.id, configuration.id, version.id, {
        yamlContent,
        ...EMPTY_GRAPH,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        version: {
          id: version.id,
          configurationId: configuration.id,
          versionNumber: 1,
          label: null,
          createdBy: { userId: account.user.id, email: account.user.email },
          yamlContent,
          nodes: [],
          edges: [],
          pipelines: [],
          createdAt: version.created_at.toISOString(),
          updatedAt: clock.toISOString(),
          publishedAt: null,
          publishedBy: null,
          ...pinned,
        },
      });
      expect(await versionOf(configuration.id)).toEqual({ ...version, yaml_content: yamlContent, updated_at: clock });
    });

    it("tells every cache to keep no copy of the answer, which carries the YAML", async () => {
      const { organization, access, configuration, version } = await withVersion();

      const response = await save(access, organization.id, configuration.id, version.id, {
        yamlContent: "a: 1\n",
        ...EMPTY_GRAPH,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("moves the configuration's updatedAt to the clock's time, so it lists first", async () => {
      const { organization, access, configuration, version } = await withVersion();
      await created(access, organization.id, "Newer");
      tick();
      expect(names(await page(access, organization.id))).toEqual(["Newer", "Gateway"]);

      expect(
        (
          await save(access, organization.id, configuration.id, version.id, {
            yamlContent: "receivers: {}\n",
            ...EMPTY_GRAPH,
          })
        ).statusCode,
      ).toBe(200);

      const body = await page(access, organization.id);
      expect(names(body)).toEqual(["Gateway", "Newer"]);
      expect(body.items[0]).toEqual({ ...configuration, updatedAt: clock.toISOString() });
      expect(await configurationRow(configuration.id)).toMatchObject({ name: "Gateway", updated_at: clock });
    });

    it("audits the save with versionId and versionNumber, and no YAML or graph anywhere in the row", async () => {
      const { account, organization, access, configuration, version } = await withVersion();
      const marker = `secret-${randomUUID()}`;

      await save(access, organization.id, configuration.id, version.id, {
        yamlContent: `exporters:\n  otlp:\n    headers: { authorization: ${marker} }\n`,
        ...graphWithReceiver((receiver) => {
          receiver.data.label = `${marker}-label`;
          receiver.data.config = { headers: { authorization: `${marker}-config` } };
        }),
      });

      const audits = await configurationAudits();
      expect(audits.at(-1)).toEqual({
        id: expect.any(String),
        occurred_at: expect.any(Date),
        action: "configuration.version_saved",
        actor_user_id: account.user.id,
        actor_email: account.user.email,
        organization_id: organization.id,
        subject_type: "configuration",
        subject_id: configuration.id,
        metadata: { versionId: version.id, versionNumber: 1 },
        ip_address: expect.any(String),
        user_agent: expect.any(String),
      });
      expect(JSON.stringify(audits)).not.toContain(marker);
      expect(JSON.stringify(audits)).not.toContain("exporters");
      // Nor the graph, whose nodes hold copies of the YAML.
      expect(JSON.stringify(audits)).not.toContain("node_0");
      expect(JSON.stringify(audits)).not.toContain("pipeline_0");
    });

    it("lets another member save the creator's published configuration's draft version", async () => {
      const creator = await memberActiveInGroup("admin");
      const other = await memberActiveInGroup("contributor", creator.group.id);
      const configuration = await created(creator.access, creator.group.id, "Theirs");
      await publish(configuration.id);
      const first = await versionOf(configuration.id);
      const draft = await newVersion(creator.access, creator.group.id, configuration.id, {
        sourceVersionId: first.id,
        yamlContent: "",
        ...EMPTY_GRAPH,
      });
      expect(draft.statusCode).toBe(201);
      tick();

      const draftId = draft.json<{ version: VersionBody }>().version.id;
      const response = await save(other.access, creator.group.id, configuration.id, draftId, {
        yamlContent: "saved by another\n",
        ...EMPTY_GRAPH,
      });

      expect(response.statusCode).toBe(200);
      expect((await versionNumbered(configuration.id, 2)).yaml_content).toBe("saved by another\n");
      expect((await configurationAudits()).at(-1)).toMatchObject({
        action: "configuration.version_saved",
        actor_user_id: other.account.user.id,
        actor_email: other.account.user.email,
      });
    });

    it("lets the last save win: two saves in turn leave the second's text", async () => {
      const { organization, access, configuration, version } = await withVersion();

      const first = await save(access, organization.id, configuration.id, version.id, {
        yamlContent: "first\n",
        ...EMPTY_GRAPH,
      });
      tick();
      const second = await save(access, organization.id, configuration.id, version.id, {
        yamlContent: "second\n",
        ...EMPTY_GRAPH,
      });

      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(await versionOf(configuration.id)).toMatchObject({ yaml_content: "second\n", updated_at: clock });
      expect((await configurationAudits()).map((row) => row.action)).toEqual([
        "configuration.created",
        "configuration.version_saved",
        "configuration.version_saved",
      ]);
    });

    it("saves the graph with the text and reads it back equal, key order aside", async () => {
      const { organization, access, configuration, version } = await withVersion();

      const response = await save(access, organization.id, configuration.id, version.id, {
        yamlContent: "receivers: {}\n",
        ...GRAPH,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<{ version: VersionBody }>().version).toMatchObject(GRAPH);
      // jsonb keeps no key order: toEqual compares objects by their keys.
      const read_ = await read(access, organization.id, configuration.id);
      expect(read_.headers["cache-control"]).toBe("no-store");
      const { nodes, edges, pipelines } = read_.json<{ version: VersionBody }>().version;
      expect({ nodes, edges, pipelines }).toEqual(GRAPH);
      expect(await versionOf(configuration.id)).toMatchObject({ yaml_content: "receivers: {}\n", ...GRAPH });
    });

    it("replaces a stored graph with the one sent, empty arrays included", async () => {
      const { organization, access, configuration, version } = await withVersion();
      expect(
        (await save(access, organization.id, configuration.id, version.id, { yamlContent: "a: 1\n", ...GRAPH }))
          .statusCode,
      ).toBe(200);

      const response = await save(access, organization.id, configuration.id, version.id, {
        yamlContent: "a: 1\n",
        ...EMPTY_GRAPH,
      });

      expect(response.statusCode).toBe(200);
      expect(await versionOf(configuration.id)).toMatchObject({ yaml_content: "a: 1\n", ...EMPTY_GRAPH });
    });

    it("saves the same text again, auditing it again", async () => {
      const { organization, access, configuration, version } = await withVersion();
      await save(access, organization.id, configuration.id, version.id, { yamlContent: "same\n", ...EMPTY_GRAPH });
      tick();
      const again = await save(access, organization.id, configuration.id, version.id, {
        yamlContent: "same\n",
        ...EMPTY_GRAPH,
      });
      expect(again.json<{ version: VersionBody }>().version.updatedAt).toBe(clock.toISOString());
      expect((await configurationAudits()).filter((row) => row.action === "configuration.version_saved")).toHaveLength(
        2,
      );
    });

    it("accepts a save at the contract's bounds, about 4.4 MiB of JSON: the route's 5 MiB applies", async () => {
      const { organization, access, configuration, version } = await withVersion();
      const payload = maximalSave();
      for (const column of [payload.nodes, payload.edges, payload.pipelines]) {
        expect(Buffer.byteLength(JSON.stringify(column))).toBeLessThanOrEqual(GRAPH_COLUMN_BYTES);
      }
      expect(Buffer.byteLength(JSON.stringify(payload.nodes))).toBe(GRAPH_COLUMN_BYTES);
      const body = JSON.stringify(payload);
      expect(Buffer.byteLength(body)).toBeGreaterThan(4.3 * 1_048_576);
      expect(Buffer.byteLength(body)).toBeLessThan(SAVE_BODY_LIMIT);

      const response = await save(access, organization.id, configuration.id, version.id, body);

      expect(response.statusCode).toBe(200);
      const row = await versionOf(configuration.id);
      expect(row.yaml_content).toBe(payload.yamlContent);
      expect(row.nodes).toHaveLength(5_000);
      expect(row.edges).toEqual(payload.edges);
      expect(row.pipelines).toEqual(payload.pipelines);
    });

    it("accepts a body of exactly 5,242,880 bytes, and answers one byte more 413 payload_too_large, writing nothing", async () => {
      const { organization, access, configuration, version } = await withVersion();
      const json = JSON.stringify({ yamlContent: "at the limit\n", ...GRAPH });
      // JSON allows whitespace after the value: the body's size alone changes.
      const atLimit = `${json}${" ".repeat(SAVE_BODY_LIMIT - Buffer.byteLength(json))}`;
      expect(Buffer.byteLength(atLimit)).toBe(5_242_880);

      const before = await snapshot();
      expectRefusal(
        await save(access, organization.id, configuration.id, version.id, `${atLimit} `),
        413,
        "payload_too_large",
        MESSAGES.tooLarge,
      );
      expect(await snapshot()).toEqual(before);

      const response = await save(access, organization.id, configuration.id, version.id, atLimit);
      expect(response.statusCode).toBe(200);
      expect(await versionOf(configuration.id)).toMatchObject({ yaml_content: "at the limit\n", ...GRAPH });
    });

    it("answers 400 invalid_request, not 500, when the table's backstop refuses a graph the contract allowed", async () => {
      const { organization, access, configuration, version } = await withVersion();
      const marker = `Private-label-${randomUUID()}`;
      // 20,000 × 1e300: about 140 KB of JSON, well within the contract, and
      // about 6 MB of jsonb::text, over the 4 MiB check.
      const graph = graphWithReceiver((receiver) => {
        receiver.data.label = marker;
        receiver.data.config = Array.from({ length: 20_000 }, () => 1e300);
      });
      expect(Buffer.byteLength(JSON.stringify(graph.nodes))).toBeLessThan(GRAPH_COLUMN_BYTES / 4);
      const before = await snapshot();

      const response = await save(access, organization.id, configuration.id, version.id, {
        yamlContent: "receivers: {}\n",
        ...graph,
      });

      expectRefusal(response, 400, "invalid_request", MESSAGES.invalid);
      expect(response.body).not.toContain(marker);
      expect(await snapshot()).toEqual(before);
      // The database's error, whose detail holds the row, is logged nowhere.
      expect(logLines.filter((line) => line.includes(marker) || line.includes("check constraint"))).toEqual([]);
    });

    it("keeps a save's YAML and graph out of the API's log, whatever the answer, and out of every refusal's body", async () => {
      const { organization, access, configuration, version } = await withVersion();
      const marker = `Private-yaml-${randomUUID()}`;
      const yaml = `exporters:\n  otlp:\n    headers: { authorization: ${marker} }\n`;
      // The marker in a node's label and config, and in a pipeline's name.
      const graph = graphWithReceiver((receiver) => {
        receiver.data.label = `${marker} label`;
        receiver.data.config = { [marker]: marker };
      });
      graph.pipelines[0]!.name = `traces/${marker}`;
      const deleted = await created(access, organization.id, "Doomed");
      const deletedVersion = await versionOf(deleted.id);
      expect((await remove(access, organization.id, deleted.id)).statusCode).toBe(204);

      expect(
        (await save(access, organization.id, configuration.id, version.id, { yamlContent: yaml, ...graph })).statusCode,
      ).toBe(200);
      expect((await read(access, organization.id, configuration.id)).statusCode).toBe(200);
      /** The graph with its receiver changed, the marker still in its label. */
      const refusedGraph = (change: (receiver: Changeable) => void) => ({
        yamlContent: yaml,
        ...graphWithReceiver((receiver) => {
          receiver.data.label = `${marker} label`;
          change(receiver);
        }),
      });
      // Refused by the service, by the contract (the text's rules and the
      // graph's), by the parser, by the body limit and by the table's check.
      const refusals = [
        await save(access, organization.id, deleted.id, deletedVersion.id, { yamlContent: yaml, ...graph }),
        await save(access, organization.id, configuration.id, version.id, { yamlContent: `${yaml}\u0000`, ...graph }),
        await save(access, organization.id, configuration.id, version.id, { yamlContent: `${yaml}\ud800`, ...graph }),
        await save(access, organization.id, configuration.id, version.id, {
          yamlContent: `${yaml}${"a".repeat(262_144)}`,
          ...graph,
        }),
        await save(access, organization.id, configuration.id, version.id, `{"yamlContent": "${marker}`),
        await save(
          access,
          organization.id,
          configuration.id,
          version.id,
          JSON.stringify({ yamlContent: `${marker}${"\u0001".repeat(900_000)}`, ...graph }),
        ),
        await save(
          access,
          organization.id,
          configuration.id,
          version.id,
          refusedGraph((node) => (node.id = marker)),
        ),
        await save(
          access,
          organization.id,
          configuration.id,
          version.id,
          refusedGraph((node) => (node.type = marker)),
        ),
        await save(
          access,
          organization.id,
          configuration.id,
          version.id,
          refusedGraph((node) => (node.data.label = `${marker}\u0000`)),
        ),
        await save(
          access,
          organization.id,
          configuration.id,
          version.id,
          refusedGraph((node) => (node.data.config = { [`${marker}\u0000`]: `${marker}\ud800` })),
        ),
        await save(
          access,
          organization.id,
          configuration.id,
          version.id,
          refusedGraph((node) => (node.data.componentType = marker)),
        ),
        await save(
          access,
          organization.id,
          configuration.id,
          version.id,
          refusedGraph((node) => (node.measured = marker)),
        ),
        await save(
          access,
          organization.id,
          configuration.id,
          version.id,
          refusedGraph((node) => (node.data.config = marker.repeat(30_000))),
        ),
        await save(
          access,
          organization.id,
          configuration.id,
          version.id,
          refusedGraph((node) => (node.data.config = Array.from({ length: 20_000 }, () => 1e300))),
        ),
      ];
      expect(refusals.map((response) => response.statusCode)).toEqual([
        404, 400, 400, 400, 400, 413, 400, 400, 400, 400, 400, 400, 400, 400,
      ]);

      // The refusals' bodies are the envelope alone: neither the YAML, nor a
      // label, a name or a config, nor a piece of them comes back.
      for (const response of refusals) {
        expect(response.body).not.toContain(marker);
        expect(response.body).not.toContain("exporters");
      }
      const requestLines = logLines.filter((line) => line.includes(`/versions/`));
      expect(requestLines.length).toBeGreaterThan(0);
      expect(logLines.filter((line) => line.includes(marker))).toEqual([]);
    });
  });

  /**
   * A personal user's configuration, created through the API, with its
   * version 1 and a version 2 seeded by the owner; the clock moved on.
   */
  const withTwoVersions = async () => {
    const user = await personalUser();
    const configuration = await created(user.access, user.organization.id, "Gateway");
    const first = await versionOf(configuration.id);
    const second = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: user.organization.id,
      version_number: 2,
      label: "Second",
      yaml_content: "second: true\n",
      created_by_user_id: user.account.user.id,
      created_at: clock,
      updated_at: clock,
    });
    tick();
    return { ...user, configuration, first, second };
  };

  describe("GET …/configurations/:configurationId/versions/:versionId", () => {
    it("answers each version with the configuration and the list, telling every cache to keep no copy", async () => {
      const { account, organization, access, configuration, first, second } = await withTwoVersions();
      const creator = { userId: account.user.id, email: account.user.email };
      const summaries = [
        {
          id: second.id,
          versionNumber: 2,
          label: "Second",
          createdBy: creator,
          createdAt: second.created_at.toISOString(),
          updatedAt: second.updated_at.toISOString(),
          publishedAt: null,
          publishedBy: null,
          ...pinned,
        },
        {
          id: first.id,
          versionNumber: 1,
          label: null,
          createdBy: creator,
          createdAt: first.created_at.toISOString(),
          updatedAt: first.updated_at.toISOString(),
          publishedAt: null,
          publishedBy: null,
          ...pinned,
        },
      ];
      const before = await snapshot();

      for (const [row, summary] of [
        [first, summaries[1]!],
        [second, summaries[0]!],
      ] as const) {
        const response = await readVersion(access, organization.id, configuration.id, row.id);

        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toEqual({
          configuration,
          version: {
            ...summary,
            configurationId: configuration.id,
            yamlContent: row.yaml_content,
            nodes: [],
            edges: [],
            pipelines: [],
          },
          versions: summaries,
        });
      }
      // A read records no selection: only the editor's PUT does.
      expect(await snapshot()).toEqual(before);
    });

    it("lowercases an uppercased version id, which names the same row", async () => {
      const { organization, access, configuration, second } = await withTwoVersions();
      const response = await readVersion(access, organization.id, configuration.id, second.id.toUpperCase());
      expect(response.statusCode).toBe(200);
      expect(response.json<WithVersionBody>().version.id).toBe(second.id);
    });

    it("lets another member read the creator's published version", async () => {
      const creator = await memberActiveInGroup("admin");
      const other = await memberActiveInGroup("contributor", creator.group.id);
      const configuration = await created(creator.access, creator.group.id, "Theirs");
      await publish(configuration.id);
      const version = await versionOf(configuration.id);
      const response = await readVersion(other.access, creator.group.id, configuration.id, version.id);
      expect(response.statusCode).toBe(200);
      expect(response.json<WithVersionBody>().version.id).toBe(version.id);
    });

    it("answers an unknown version, and another configuration's, 404 configuration_version_not_found", async () => {
      const { organization, access, configuration } = await withTwoVersions();
      const other = await created(access, organization.id, "Other");
      const othersVersion = await versionOf(other.id);
      for (const versionId of [randomUUID(), othersVersion.id]) {
        expectRefusal(
          await readVersion(access, organization.id, configuration.id, versionId),
          404,
          "configuration_version_not_found",
          MESSAGES.versionNotFound,
        );
      }
    });

    it.each(MALFORMED_PATH_IDS)("answers a malformed version id (%s) 404 configuration_version_not_found", async (id) => {
      const { organization, access, configuration } = await withTwoVersions();
      expectRefusal(
        await readVersion(access, organization.id, configuration.id, id),
        404,
        "configuration_version_not_found",
        MESSAGES.versionNotFound,
      );
    });

    it("answers a deleted configuration's version 404 configuration_not_found", async () => {
      const { organization, access, configuration, first } = await withTwoVersions();
      expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
      for (const versionId of [first.id, randomUUID(), "42"]) {
        expectRefusal(
          await readVersion(access, organization.id, configuration.id, versionId),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
      }
    });

    it("answers an unknown configuration's version 404 configuration_not_found", async () => {
      const { organization, access, first } = await withTwoVersions();
      const unknown = randomUUID();
      for (const versionId of [first.id, randomUUID(), "42"]) {
        expectRefusal(
          await readVersion(access, organization.id, unknown, versionId),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
      }
    });

    it.each(["not-a-uuid", "42", "0192F1A47B3C7D2E8F101A2B3C4D5E6F"])(
      "answers a malformed configuration id (%s) 404 configuration_not_found",
      async (id) => {
        const { organization, access, first } = await withTwoVersions();
        expectRefusal(
          await readVersion(access, organization.id, id, first.id),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
      },
    );
  });

  describe("GET …/configurations/:configurationId/versions", () => {
    /** A listed version's keys, exactly: no content, layout, member, time or collector version. */
    const LIST_ITEM_KEYS = ["id", "label", "publishedAt", "versionNumber"];

    /** A listed version as the versions route answers it. */
    interface VersionListItemBody {
      id: string;
      versionNumber: number;
      label: string | null;
      publishedAt: string | null;
    }

    /** A version's summary (the editor's read's) as the versions route lists it. */
    const listItemOf = ({ id, versionNumber, label, publishedAt }: VersionSummaryBody): VersionListItemBody => ({
      id,
      versionNumber,
      label,
      publishedAt,
    });

    /**
     * A's configuration in a group: version 1 published, a draft version 2
     * created through the API, and a version 10 seeded and published (the
     * order is by number, not by text or insertion); B, A's teammate, a
     * `role`. Each version's YAML holds a marker no summary may carry.
     */
    const publishedWithDrafts = async (role: OrganizationRole) => {
      const a = await memberActiveInGroup("admin");
      const b = await memberActiveInGroup(role, a.group.id);
      const configuration = await created(a.access, a.group.id, "Edge gateway");
      const first = await versionOf(configuration.id);
      await ownerDb
        .updateTable("configuration_versions")
        .set({ yaml_content: "marker-of-the-yaml: 1\n" })
        .where("id", "=", first.id)
        .execute();
      const firstPublishedAt = await publish(configuration.id, 1, a.account.user.id);
      const second = await newVersion(a.access, a.group.id, configuration.id, {
        sourceVersionId: first.id,
        label: "Draft",
        yamlContent: "marker-of-the-yaml: 2\n",
        ...GRAPH,
      });
      expect(second.statusCode).toBe(201);
      const tenth = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: a.group.id,
        version_number: 10,
        label: "Ten",
        yaml_content: "marker-of-the-yaml: 10\n",
        created_by_user_id: a.account.user.id,
        created_at: clock,
        updated_at: clock,
      });
      const tenthPublishedAt = await publish(configuration.id, 10, a.account.user.id);
      tick();
      return { a, b, group: a.group, configuration, first, second, tenth, firstPublishedAt, tenthPublishedAt };
    };

    /** The answer's versions, checked to carry exactly the four keys, no YAML, no email and no cache header. */
    const listedOf = (response: LightMyRequestResponse) => {
      expect(response.statusCode).toBe(200);
      // Labels, as the configurations list: cacheable.
      expect(response.headers["cache-control"]).toBeUndefined();
      expect(response.body).not.toContain("marker-of-the-yaml");
      expect(response.body).not.toContain("@example.com");
      const body = response.json<{ versions: Record<string, unknown>[] }>();
      expect(Object.keys(body)).toEqual(["versions"]);
      for (const version of body.versions) expect(Object.keys(version).sort()).toEqual(LIST_ITEM_KEYS);
      return body.versions as unknown as VersionListItemBody[];
    };

    it.each(["admin", "contributor"] as const)(
      "lists every version, highest number first, each its id, number, label and published date only, to a teammate (%s)",
      async (role) => {
        const { b, group, configuration } = await publishedWithDrafts(role);
        const editors = (await read(b.access, group.id, configuration.id)).json<WithVersionBody>().versions;

        for (const query of ["", "?filter=all"]) {
          const versions = listedOf(await listVersions(b.access, group.id, configuration.id, query));
          expect(versions.map((version) => version.versionNumber)).toEqual([10, 2, 1]);
          expect(versions).toEqual(editors.map(listItemOf));
        }
      },
    );

    it.each(["admin", "contributor"] as const)(
      "lists only the published versions for filter=published, highest first, to a teammate (%s)",
      async (role) => {
        const { b, group, configuration, first, tenth, firstPublishedAt, tenthPublishedAt } = await publishedWithDrafts(role);

        const versions = listedOf(await listVersions(b.access, group.id, configuration.id, "?filter=published"));

        expect(versions).toEqual([
          { id: tenth.id, versionNumber: 10, label: "Ten", publishedAt: tenthPublishedAt.toISOString() },
          { id: first.id, versionNumber: 1, label: null, publishedAt: firstPublishedAt.toISOString() },
        ]);
      },
    );

    it("lists the caller's own draft configuration's versions, and none of them published", async () => {
      const { organization, access, configuration, first, second } = await withTwoVersions();
      expect(listedOf(await listVersions(access, organization.id, configuration.id))).toEqual([
        { id: second.id, versionNumber: 2, label: "Second", publishedAt: null },
        { id: first.id, versionNumber: 1, label: null, publishedAt: null },
      ]);
      expect(listedOf(await listVersions(access, organization.id, configuration.id, "?filter=published"))).toEqual([]);
    });

    it("reads and writes nothing else: no selection, no audit row", async () => {
      const { organization, access, configuration } = await withTwoVersions();
      const before = await snapshot();
      expect((await listVersions(access, organization.id, configuration.id)).statusCode).toBe(200);
      expect(await snapshot()).toEqual(before);
    });

    it("lowercases an uppercased configuration id, which names the same row", async () => {
      const { organization, access, configuration, second } = await withTwoVersions();
      const versions = listedOf(await listVersions(access, organization.id, configuration.id.toUpperCase()));
      expect(versions[0]!.id).toBe(second.id);
    });

    it.each(["?filter=", "?filter=mine", "?filter=Published", "?filter=drafts", "?filter=all&filter=published", "?limit=10", "?cursor=abc"])(
      "answers %s 400 invalid_request",
      async (query) => {
        const { organization, access, configuration } = await withTwoVersions();
        expectInvalid(await listVersions(access, organization.id, configuration.id, query));
      },
    );

    it.each(["admin", "contributor"] as const)(
      "answers another member's draft-only configuration 404 configuration_not_found, whatever the filter, to a teammate (%s), as an unknown one",
      async (role) => {
        const a = await memberActiveInGroup("contributor");
        const b = await memberActiveInGroup(role, a.group.id);
        const configuration = await created(a.access, a.group.id, "A's draft");
        for (const id of [configuration.id, randomUUID()]) {
          for (const query of ["", "?filter=all", "?filter=published"]) {
            expectRefusal(
              await listVersions(b.access, a.group.id, id, query),
              404,
              "configuration_not_found",
              MESSAGES.configurationNotFound,
            );
          }
        }
        // Its author lists it.
        expect((await listVersions(a.access, a.group.id, configuration.id)).statusCode).toBe(200);
      },
    );

    it("answers another organization's configuration, published, through the caller's own organization 404 configuration_not_found, and through its organization 404 organization_not_found", async () => {
      const elsewhere = await memberActiveInGroup("admin");
      const configuration = await created(elsewhere.access, elsewhere.group.id, "Theirs");
      await publish(configuration.id);
      const { organization, access } = await personalUser();

      for (const query of ["", "?filter=published"]) {
        expectRefusal(
          await listVersions(access, organization.id, configuration.id, query),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
        expectRefusal(
          await listVersions(access, elsewhere.group.id, configuration.id, query),
          404,
          "organization_not_found",
          MESSAGES.organizationNotFound,
        );
      }
      // Its own organization's members list it.
      expect(listedOf(await listVersions(elsewhere.access, elsewhere.group.id, configuration.id, "?filter=published"))).toHaveLength(1);
    });

    it("answers a deleted configuration 404 configuration_not_found", async () => {
      const { organization, access, configuration } = await withTwoVersions();
      expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
      for (const query of ["", "?filter=published"]) {
        expectRefusal(
          await listVersions(access, organization.id, configuration.id, query),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
      }
    });

    it.each(MALFORMED_PATH_IDS)("answers a malformed configuration id (%s) 404 configuration_not_found", async (id) => {
      const { organization, access } = await withTwoVersions();
      expectRefusal(
        await listVersions(access, organization.id, id),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
    });
  });

  describe("POST …/configurations/:configurationId/versions", () => {
    it("creates the next version: 201, the content and label as sent, the caller as creator, the clock's timestamps, the configuration touched, the source unchanged, and its audit row", async () => {
      const { account, organization, access, configuration, first, second } = await withTwoVersions();
      const yamlContent = "receivers:\r\n  otlp: {} # 🚀 unsaved\n";

      const response = await newVersion(access, organization.id, configuration.id, {
        sourceVersionId: first.id,
        label: "  Add tail sampling  ",
        yamlContent,
        ...GRAPH,
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const { version } = response.json<{ version: VersionBody }>();
      expect(version).toEqual({
        id: expect.any(String),
        configurationId: configuration.id,
        versionNumber: 3,
        label: "Add tail sampling",
        createdBy: { userId: account.user.id, email: account.user.email },
        yamlContent,
        ...GRAPH,
        createdAt: clock.toISOString(),
        updatedAt: clock.toISOString(),
        publishedAt: null,
        publishedBy: null,
        ...pinned,
      });
      expect(await versionNumbered(configuration.id, 3)).toEqual({
        id: version.id,
        configuration_id: configuration.id,
        organization_id: organization.id,
        version_number: 3,
        label: "Add tail sampling",
        yaml_content: yamlContent,
        ...GRAPH,
        created_by_user_id: account.user.id,
        created_at: clock,
        updated_at: clock,
        // A new version is a draft.
        published_at: null,
        published_by_user_id: null,
        publication_id: null,
        // Its source's pin.
        collector_distribution: first.collector_distribution,
        collector_version: first.collector_version,
      });
      expect(await configurationRow(configuration.id)).toMatchObject({ updated_at: clock });
      // The source, and every other version, as they were.
      expect(await versionNumbered(configuration.id, 1)).toEqual(first);
      expect(await versionNumbered(configuration.id, 2)).toEqual(second);
      expect((await configurationAudits()).at(-1)).toEqual({
        id: expect.any(String),
        occurred_at: expect.any(Date),
        action: "configuration.version_created",
        actor_user_id: account.user.id,
        actor_email: account.user.email,
        organization_id: organization.id,
        subject_type: "configuration",
        subject_id: configuration.id,
        // The source's suites and validation pipelines copied: none here.
        metadata: {
          versionId: version.id,
          versionNumber: 3,
          sourceVersionId: first.id,
          copiedSuites: 0,
          copiedDefinitions: 0,
          copiedValidationPipelines: 0,
          copiedValidationRules: 0,
        },
        ip_address: expect.any(String),
        user_agent: expect.any(String),
      });
      // It lists first, and the configuration's read lists it.
      expect((await page(access, organization.id)).items[0]).toMatchObject({
        id: configuration.id,
        updatedAt: clock.toISOString(),
      });
      const read_ = await read(access, organization.id, configuration.id);
      expect(read_.json<WithVersionBody>().versions.map((summary) => summary.versionNumber)).toEqual([3, 2, 1]);
    });

    it("pins the new version to its source's collector version, not the catalog's default", async () => {
      const { organization, access, configuration, first, second } = await withTwoVersions();
      // The source, a draft, pinned to another version of the catalog than the default.
      await ownerDb
        .updateTable("configuration_versions")
        .set({ collector_version: otherVersion })
        .where("id", "=", first.id)
        .execute();

      const fromFirst = await newVersion(access, organization.id, configuration.id, {
        sourceVersionId: first.id,
        yamlContent: "",
        ...EMPTY_GRAPH,
      });
      expect(fromFirst.statusCode).toBe(201);
      expect(await versionNumbered(configuration.id, 3)).toMatchObject({
        collector_distribution: pin.distribution,
        collector_version: otherVersion,
      });

      const fromSecond = await newVersion(access, organization.id, configuration.id, {
        sourceVersionId: second.id,
        yamlContent: "",
        ...EMPTY_GRAPH,
      });
      expect(fromSecond.statusCode).toBe(201);
      expect(await versionNumbered(configuration.id, 4)).toMatchObject({
        collector_distribution: pin.distribution,
        collector_version: pin.version,
      });
    });

    it.each([
      ["CRLF line endings", "receivers:\r\n  otlp:\r\n    protocols: {}\r\n"],
      ["''", ""],
      ["a non-BMP character", "# 🚀 𝕏\nreceivers: {}\n"],
      ["leading and trailing whitespace", "\n\t  receivers: {}   \n\n"],
    ])("keeps %s exactly as sent", async (_label, yamlContent) => {
      const { organization, access, configuration, first } = await withTwoVersions();

      const response = await newVersion(access, organization.id, configuration.id, {
        sourceVersionId: first.id,
        yamlContent,
        ...EMPTY_GRAPH,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json<{ version: VersionBody }>().version.yamlContent).toBe(yamlContent);
      expect((await versionNumbered(configuration.id, 3)).yaml_content).toBe(yamlContent);
    });

    it("keeps the graph as sent, equal key order aside", async () => {
      const { organization, access, configuration, first } = await withTwoVersions();
      const response = await newVersion(access, organization.id, configuration.id, {
        sourceVersionId: first.id,
        yamlContent: "receivers: {}\n",
        ...GRAPH,
      });
      expect(response.statusCode).toBe(201);
      const { nodes, edges, pipelines } = response.json<{ version: VersionBody }>().version;
      expect({ nodes, edges, pipelines }).toEqual(GRAPH);
      expect(await versionNumbered(configuration.id, 3)).toMatchObject(GRAPH);
    });

    it.each([
      ["left out", {}],
      ["''", { label: "" }],
      ["whitespace only", { label: "   " }],
    ])("makes an unnamed version when the label is %s", async (_label, label) => {
      const { organization, access, configuration, first } = await withTwoVersions();
      const response = await newVersion(access, organization.id, configuration.id, {
        sourceVersionId: first.id,
        ...label,
        yamlContent: "",
        ...EMPTY_GRAPH,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json<{ version: VersionBody }>().version.label).toBeNull();
      expect((await versionNumbered(configuration.id, 3)).label).toBeNull();
    });

    it("accepts an 80-character label", async () => {
      const { organization, access, configuration, first } = await withTwoVersions();
      const label = "a".repeat(80);
      const response = await newVersion(access, organization.id, configuration.id, {
        sourceVersionId: first.id,
        label,
        yamlContent: "",
        ...EMPTY_GRAPH,
      });
      expect(response.statusCode).toBe(201);
      expect((await versionNumbered(configuration.id, 3)).label).toBe(label);
    });

    it("numbers after the highest, across a gap, and never reuses a number", async () => {
      const { organization, access, configuration, first } = await withTwoVersions();
      await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: organization.id,
        version_number: 7,
      });
      const numbers: number[] = [];
      for (let index = 0; index < 2; index += 1) {
        const response = await newVersion(access, organization.id, configuration.id, {
          sourceVersionId: first.id,
          yamlContent: "",
          ...EMPTY_GRAPH,
        });
        expect(response.statusCode).toBe(201);
        numbers.push(response.json<{ version: VersionBody }>().version.versionNumber);
      }
      expect(numbers).toEqual([8, 9]);
    });

    it("lets another member create a version of the creator's published configuration, as its creator, from its published version", async () => {
      const creator = await memberActiveInGroup("admin");
      const other = await memberActiveInGroup("contributor", creator.group.id);
      const configuration = await created(creator.access, creator.group.id, "Theirs");
      await publish(configuration.id);
      const version = await versionOf(configuration.id);
      tick();

      const response = await newVersion(other.access, creator.group.id, configuration.id, {
        sourceVersionId: version.id,
        yamlContent: "by another\n",
        ...EMPTY_GRAPH,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json<{ version: VersionBody }>().version).toMatchObject({
        createdBy: { userId: other.account.user.id, email: other.account.user.email },
        // A new version is a draft, whatever its source.
        publishedAt: null,
        publishedBy: null,
        ...pinned,
      });
      expect((await configurationAudits()).at(-1)).toMatchObject({
        action: "configuration.version_created",
        actor_user_id: other.account.user.id,
      });
    });

    it("keeps the YAML, the graph and the label out of the audit row and the API's log", async () => {
      const { organization, access, configuration, first } = await withTwoVersions();
      const marker = `secret-${randomUUID()}`;

      const response = await newVersion(access, organization.id, configuration.id, {
        sourceVersionId: first.id,
        label: `${marker}-label`.slice(0, 80),
        yamlContent: `exporters:\n  otlp:\n    headers: { authorization: ${marker} }\n`,
        ...graphWithReceiver((receiver) => {
          receiver.data.label = `${marker}-node`;
          receiver.data.config = { headers: { authorization: `${marker}-config` } };
        }),
      });
      expect(response.statusCode).toBe(201);

      const audits = await configurationAudits();
      expect(audits.at(-1)!.metadata).toEqual({
        versionId: response.json<{ version: VersionBody }>().version.id,
        versionNumber: 3,
        sourceVersionId: first.id,
        copiedSuites: 0,
        copiedDefinitions: 0,
        copiedValidationPipelines: 0,
        copiedValidationRules: 0,
      });
      const audited = JSON.stringify(audits);
      for (const secret of [marker, "exporters", "node_0", "pipeline_0"]) expect(audited).not.toContain(secret);
      expect(logLines.filter((line) => line.includes("/versions")).length).toBeGreaterThan(0);
      expect(logLines.filter((line) => line.includes(marker))).toEqual([]);
    });

    it("accepts a body of exactly 5,242,880 bytes, and answers one byte more 413 payload_too_large, writing nothing", async () => {
      const { organization, access, configuration, first } = await withTwoVersions();
      const json = JSON.stringify({ sourceVersionId: first.id, yamlContent: "at the limit\n", ...GRAPH });
      const atLimit = `${json}${" ".repeat(SAVE_BODY_LIMIT - Buffer.byteLength(json))}`;
      expect(Buffer.byteLength(atLimit)).toBe(5_242_880);

      const before = await snapshot();
      expectRefusal(
        await newVersion(access, organization.id, configuration.id, `${atLimit} `),
        413,
        "payload_too_large",
        MESSAGES.tooLarge,
      );
      expect(await snapshot()).toEqual(before);

      const response = await newVersion(access, organization.id, configuration.id, atLimit);
      expect(response.statusCode).toBe(201);
      expect(await versionNumbered(configuration.id, 3)).toMatchObject({ yaml_content: "at the limit\n", ...GRAPH });
    });

    it("answers 400 invalid_request, not 500, when the table's backstop refuses a graph the contract allowed, writing nothing", async () => {
      const { organization, access, configuration, first } = await withTwoVersions();
      const graph = graphWithReceiver((receiver) => {
        receiver.data.config = Array.from({ length: 20_000 }, () => 1e300);
      });
      const before = await snapshot();
      expectRefusal(
        await newVersion(access, organization.id, configuration.id, {
          sourceVersionId: first.id,
          yamlContent: "receivers: {}\n",
          ...graph,
        }),
        400,
        "invalid_request",
        MESSAGES.invalid,
      );
      expect(await snapshot()).toEqual(before);
    });

    describe("refusals, each writing nothing", () => {
      it("an unknown, a deleted or a malformed configuration: 404 configuration_not_found", async () => {
        const { organization, access, configuration, first } = await withTwoVersions();
        expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
        const before = await snapshot();
        for (const id of [randomUUID(), configuration.id, ...MALFORMED_PATH_IDS]) {
          expectRefusal(
            await newVersion(access, organization.id, id, {
              sourceVersionId: first.id,
              yamlContent: "",
              ...EMPTY_GRAPH,
            }),
            404,
            "configuration_not_found",
            MESSAGES.configurationNotFound,
          );
        }
        expect(await snapshot()).toEqual(before);
      });

      it("an unknown source, and another configuration's: 404 configuration_version_not_found", async () => {
        const { organization, access, configuration } = await withTwoVersions();
        const other = await created(access, organization.id, "Other");
        const othersVersion = await versionOf(other.id);
        const before = await snapshot();
        for (const sourceVersionId of [randomUUID(), othersVersion.id]) {
          expectRefusal(
            await newVersion(access, organization.id, configuration.id, {
              sourceVersionId,
              yamlContent: "",
              ...EMPTY_GRAPH,
            }),
            404,
            "configuration_version_not_found",
            MESSAGES.versionNotFound,
          );
        }
        expect(await snapshot()).toEqual(before);
      });

      it.each(MALFORMED_BODY_IDS)(
        "a malformed source (%j): 404 configuration_version_not_found",
        async (sourceVersionId) => {
          const { organization, access, configuration } = await withTwoVersions();
          const before = await snapshot();
          expectRefusal(
            await newVersion(access, organization.id, configuration.id, {
              sourceVersionId,
              yamlContent: "",
              ...EMPTY_GRAPH,
            }),
            404,
            "configuration_version_not_found",
            MESSAGES.versionNotFound,
          );
          expect(await snapshot()).toEqual(before);
        },
      );

      it.each([
        ["an 81-character label", { label: "a".repeat(81) }],
        ["a null label", { label: null }],
        // Postgres can't store these exactly: 400, never a 500 or a U+FFFD stored.
        ["U+0000 in the label", { label: "Tail\u0000sampling" }],
        ["a lone surrogate in the label", { label: "Tail\ud800sampling" }],
        ["262,145 characters of YAML", { yamlContent: "a".repeat(262_145) }],
        ["U+0000 in the YAML", { yamlContent: "a\u0000" }],
        ["no sourceVersionId", { sourceVersionId: undefined }],
        ["a source over 64 characters", { sourceVersionId: "a".repeat(65) }],
        ["no nodes", { nodes: undefined }],
        ["a graph with a name in an id", { nodes: [{ ...RECEIVER, id: "receiver-otlp" }] }],
        ["an unknown field", { versionNumber: 2 }],
      ])("%s: 400 invalid_request", async (_label, change) => {
        const { organization, access, configuration, first } = await withTwoVersions();
        const before = await snapshot();
        expectInvalid(
          await newVersion(access, organization.id, configuration.id, {
            sourceVersionId: first.id,
            yamlContent: "",
            ...EMPTY_GRAPH,
            ...change,
          }),
        );
        expect(await snapshot()).toEqual(before);
      });

      it("a body over 5 MiB: 413 payload_too_large", async () => {
        const { organization, access, configuration, first } = await withTwoVersions();
        const body = JSON.stringify({ sourceVersionId: first.id, yamlContent: "\u0001".repeat(900_000), ...EMPTY_GRAPH });
        expect(body.length).toBeGreaterThan(SAVE_BODY_LIMIT);
        const before = await snapshot();
        expectRefusal(
          await newVersion(access, organization.id, configuration.id, body),
          413,
          "payload_too_large",
          MESSAGES.tooLarge,
        );
        expect(await snapshot()).toEqual(before);
      });
    });
  });

  describe("PUT …/configurations/:configurationId/versions/:versionId/label", () => {
    it("renames: 200 with the summary, the label trimmed, no updatedAt moved, and its audit row", async () => {
      const { account, organization, access, configuration, first } = await withTwoVersions();
      const configurationBefore = await configurationRow(configuration.id);

      const response = await renameVersion(access, organization.id, configuration.id, first.id, {
        label: "  Baseline  ",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        version: {
          id: first.id,
          versionNumber: 1,
          label: "Baseline",
          createdBy: { userId: account.user.id, email: account.user.email },
          createdAt: first.created_at.toISOString(),
          updatedAt: first.updated_at.toISOString(),
          publishedAt: null,
          publishedBy: null,
          ...pinned,
        },
      });
      expect(await versionNumbered(configuration.id, 1)).toEqual({ ...first, label: "Baseline" });
      expect(await configurationRow(configuration.id)).toEqual(configurationBefore);
      expect((await configurationAudits()).at(-1)).toEqual({
        id: expect.any(String),
        occurred_at: expect.any(Date),
        action: "configuration.version_renamed",
        actor_user_id: account.user.id,
        actor_email: account.user.email,
        organization_id: organization.id,
        subject_type: "configuration",
        subject_id: configuration.id,
        metadata: { versionId: first.id, versionNumber: 1, from: null, to: "Baseline" },
        ip_address: expect.any(String),
        user_agent: expect.any(String),
      });
    });

    it("audits from the old label to the new one", async () => {
      const { organization, access, configuration, second } = await withTwoVersions();
      expect(
        (await renameVersion(access, organization.id, configuration.id, second.id, { label: "Renamed" })).statusCode,
      ).toBe(200);
      expect((await configurationAudits()).at(-1)!.metadata).toEqual({
        versionId: second.id,
        versionNumber: 2,
        from: "Second",
        to: "Renamed",
      });
    });

    it.each([
      ["the same label", "Second"],
      ["the same label, untrimmed", "  Second "],
    ])("answers %s 200 with the summary as it is, writing and auditing nothing", async (_label, label) => {
      const { account, organization, access, configuration, second } = await withTwoVersions();
      const before = await snapshot();

      const response = await renameVersion(access, organization.id, configuration.id, second.id, { label });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        version: {
          id: second.id,
          versionNumber: 2,
          label: "Second",
          createdBy: { userId: account.user.id, email: account.user.email },
          createdAt: second.created_at.toISOString(),
          updatedAt: second.updated_at.toISOString(),
          publishedAt: null,
          publishedBy: null,
          ...pinned,
        },
      });
      expect(await snapshot()).toEqual(before);
    });

    it("accepts 80 characters, and lets another member rename the creator's published configuration's draft version", async () => {
      const creator = await memberActiveInGroup("admin");
      const other = await memberActiveInGroup("contributor", creator.group.id);
      const configuration = await created(creator.access, creator.group.id, "Theirs");
      await publish(configuration.id);
      await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: creator.group.id,
        version_number: 2,
      });
      const version = await versionNumbered(configuration.id, 2);

      const response = await renameVersion(other.access, creator.group.id, configuration.id, version.id, {
        label: "a".repeat(80),
      });

      expect(response.statusCode).toBe(200);
      expect((await versionNumbered(configuration.id, 2)).label).toBe("a".repeat(80));
      expect((await configurationAudits()).at(-1)).toMatchObject({
        action: "configuration.version_renamed",
        actor_user_id: other.account.user.id,
      });
    });

    describe("refusals, each writing nothing", () => {
      it("an unknown, a deleted or a malformed configuration: 404 configuration_not_found", async () => {
        const { organization, access, configuration, first } = await withTwoVersions();
        expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
        const before = await snapshot();
        for (const id of [randomUUID(), configuration.id, ...MALFORMED_PATH_IDS]) {
          expectRefusal(
            await renameVersion(access, organization.id, id, first.id, { label: "Sneaky" }),
            404,
            "configuration_not_found",
            MESSAGES.configurationNotFound,
          );
        }
        expect(await snapshot()).toEqual(before);
      });

      it("an unknown version, another configuration's, and a malformed one: 404 configuration_version_not_found", async () => {
        const { organization, access, configuration } = await withTwoVersions();
        const other = await created(access, organization.id, "Other");
        const othersVersion = await versionOf(other.id);
        const before = await snapshot();
        for (const versionId of [randomUUID(), othersVersion.id, ...MALFORMED_PATH_IDS]) {
          expectRefusal(
            await renameVersion(access, organization.id, configuration.id, versionId, { label: "Sneaky" }),
            404,
            "configuration_version_not_found",
            MESSAGES.versionNotFound,
          );
        }
        expect(await snapshot()).toEqual(before);
      });

      it.each([
        ["an 81-character label", { label: "a".repeat(81) }],
        ["''", { label: "" }],
        ["a whitespace-only label", { label: "   " }],
        ["a null label", { label: null }],
        ["no label", {}],
        ["an unknown field", { label: "A", versionNumber: 2 }],
        // Postgres can't store these exactly: 400, never a 500 or a U+FFFD stored.
        ["U+0000 in the label", { label: "Re\u0000named" }],
        ["a lone surrogate in the label", { label: "Re\udc00named" }],
      ])("%s: 400 invalid_request", async (_label, payload) => {
        const { organization, access, configuration, first } = await withTwoVersions();
        const before = await snapshot();
        expectInvalid(await renameVersion(access, organization.id, configuration.id, first.id, payload));
        expect(await snapshot()).toEqual(before);
      });
    });
  });

  describe("PUT …/configurations/:configurationId/selected-version", () => {
    it("records the caller's selection: 204, the clock's time, no audit row; the read then opens it", async () => {
      const { account, organization, access, configuration, first } = await withTwoVersions();
      const audits = await configurationAudits();

      const response = await selectVersion(access, organization.id, configuration.id, { versionId: first.id });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(await selectionRows()).toEqual([
        {
          id: expect.any(String),
          organization_id: organization.id,
          configuration_id: configuration.id,
          version_id: first.id,
          user_id: account.user.id,
          selected_at: clock,
        },
      ]);
      expect(await configurationAudits()).toEqual(audits);
      expect((await read(access, organization.id, configuration.id)).json<WithVersionBody>().version.id).toBe(first.id);
    });

    it("replaces the caller's earlier selection, keeping one row", async () => {
      const { organization, access, configuration, first, second } = await withTwoVersions();
      expect((await selectVersion(access, organization.id, configuration.id, { versionId: first.id })).statusCode).toBe(
        204,
      );
      tick();
      expect(
        (await selectVersion(access, organization.id, configuration.id, { versionId: second.id.toUpperCase() }))
          .statusCode,
      ).toBe(204);

      expect(await selectionRows()).toEqual([
        expect.objectContaining({ version_id: second.id, selected_at: clock }),
      ]);
      expect((await read(access, organization.id, configuration.id)).json<WithVersionBody>().version.id).toBe(
        second.id,
      );
    });

    it("leaves another person's read as it was: they get the highest", async () => {
      const a = await memberActiveInGroup("admin");
      const b = await memberActiveInGroup("contributor", a.group.id);
      const configuration = await created(a.access, a.group.id, "Shared");
      // Published, so B sees it.
      await publish(configuration.id);
      const first = await versionOf(configuration.id);
      const second = await newVersion(a.access, a.group.id, configuration.id, {
        sourceVersionId: first.id,
        yamlContent: "",
        ...EMPTY_GRAPH,
      });
      const secondId = second.json<{ version: VersionBody }>().version.id;

      expect((await selectVersion(a.access, a.group.id, configuration.id, { versionId: first.id })).statusCode).toBe(204);

      expect((await read(b.access, a.group.id, configuration.id)).json<WithVersionBody>().version.id).toBe(secondId);
      expect((await read(a.access, a.group.id, configuration.id)).json<WithVersionBody>().version.id).toBe(first.id);
      expect((await selectionRows()).map((row) => row.user_id)).toEqual([a.account.user.id]);
    });

    describe("refusals, each writing nothing", () => {
      it("an unknown, a deleted or a malformed configuration: 404 configuration_not_found", async () => {
        const { organization, access, configuration, first } = await withTwoVersions();
        expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
        const before = await snapshot();
        for (const id of [randomUUID(), configuration.id, ...MALFORMED_PATH_IDS]) {
          expectRefusal(
            await selectVersion(access, organization.id, id, { versionId: first.id }),
            404,
            "configuration_not_found",
            MESSAGES.configurationNotFound,
          );
        }
        expect(await snapshot()).toEqual(before);
      });

      it("an unknown version, and another configuration's: 404 configuration_version_not_found", async () => {
        const { organization, access, configuration } = await withTwoVersions();
        const other = await created(access, organization.id, "Other");
        const othersVersion = await versionOf(other.id);
        const before = await snapshot();
        for (const versionId of [randomUUID(), othersVersion.id]) {
          expectRefusal(
            await selectVersion(access, organization.id, configuration.id, { versionId }),
            404,
            "configuration_version_not_found",
            MESSAGES.versionNotFound,
          );
        }
        expect(await snapshot()).toEqual(before);
      });

      it.each(MALFORMED_BODY_IDS)(
        "a malformed selection (%j): 404 configuration_version_not_found",
        async (versionId) => {
          const { organization, access, configuration } = await withTwoVersions();
          const before = await snapshot();
          expectRefusal(
            await selectVersion(access, organization.id, configuration.id, { versionId }),
            404,
            "configuration_version_not_found",
            MESSAGES.versionNotFound,
          );
          expect(await snapshot()).toEqual(before);
        },
      );

      it.each([
        ["no versionId", {}],
        ["a null versionId", { versionId: null }],
        ["a versionId over 64 characters", { versionId: "a".repeat(65) }],
        ["an unknown field", { versionId: randomUUID(), userId: randomUUID() }],
      ])("%s: 400 invalid_request", async (_label, payload) => {
        const { organization, access, configuration } = await withTwoVersions();
        const before = await snapshot();
        expectInvalid(await selectVersion(access, organization.id, configuration.id, payload));
        expect(await snapshot()).toEqual(before);
      });
    });
  });

  describe("PATCH …/configurations/:configurationId", () => {
    const withConfiguration = async () => {
      const user = await personalUser();
      const configuration = await created(user.access, user.organization.id, "Gateway", "Edge collector");
      tick();
      return { ...user, configuration };
    };

    it("renames, moving updatedAt to the clock's time, and audits only the name", async () => {
      const { organization, access, configuration } = await withConfiguration();

      const response = await change(access, organization.id, configuration.id, { name: "  Renamed  " });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        configuration: { ...configuration, name: "Renamed", updatedAt: clock.toISOString() },
      });
      expect(await configurationRow(configuration.id)).toMatchObject({ name: "Renamed", updated_at: clock });
      expect((await configurationAudits()).at(-1)).toMatchObject({
        action: "configuration.updated",
        subject_type: "configuration",
        subject_id: configuration.id,
        organization_id: organization.id,
        metadata: { from: { name: "Gateway" }, to: { name: "Renamed" } },
      });
    });

    it("changes the description, auditing only it", async () => {
      const { organization, access, configuration } = await withConfiguration();
      const response = await change(access, organization.id, configuration.id, { description: "Prod" });
      expect(response.json()).toMatchObject({ configuration: { name: "Gateway", description: "Prod" } });
      expect((await configurationAudits()).at(-1)!.metadata).toEqual({
        from: { description: "Edge collector" },
        to: { description: "Prod" },
      });
    });

    it("changes both, auditing both", async () => {
      const { organization, access, configuration } = await withConfiguration();
      const response = await change(access, organization.id, configuration.id, { name: "N", description: "D" });
      expect(response.json()).toMatchObject({ configuration: { name: "N", description: "D" } });
      expect((await configurationAudits()).at(-1)!.metadata).toEqual({
        from: { name: "Gateway", description: "Edge collector" },
        to: { name: "N", description: "D" },
      });
    });

    it("clears the description with ''", async () => {
      const { organization, access, configuration } = await withConfiguration();
      const response = await change(access, organization.id, configuration.id, { description: "" });
      expect(response.json()).toMatchObject({ configuration: { description: "" } });
      expect((await configurationRow(configuration.id)).description).toBe("");
    });

    it("audits only the changed field when the other is sent as it is", async () => {
      const { organization, access, configuration } = await withConfiguration();
      await change(access, organization.id, configuration.id, { name: "Gateway", description: "New" });
      expect((await configurationAudits()).at(-1)!.metadata).toEqual({
        from: { description: "Edge collector" },
        to: { description: "New" },
      });
    });

    it.each([
      ["an empty body", {}],
      ["the values already there", { name: "Gateway", description: "Edge collector" }],
      ["the values already there, untrimmed", { name: " Gateway " }],
    ])("answers %s 200 with the configuration as it is, bumping and auditing nothing", async (_label, payload) => {
      const { organization, access, configuration } = await withConfiguration();
      const before = await snapshot();

      const response = await change(access, organization.id, configuration.id, payload);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ configuration });
      expect(await snapshot()).toEqual(before);
    });

    it("lets another member rename the creator's published configuration", async () => {
      const creator = await memberActiveInGroup("admin");
      const other = await memberActiveInGroup("contributor", creator.group.id);
      const configuration = await created(creator.access, creator.group.id, "Theirs");
      await publish(configuration.id);
      tick();

      const response = await change(other.access, creator.group.id, configuration.id, { name: "Renamed by another" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        configuration: {
          name: "Renamed by another",
          createdBy: { userId: creator.account.user.id, email: creator.account.user.email },
        },
      });
      expect((await configurationAudits()).at(-1)).toMatchObject({
        action: "configuration.updated",
        actor_user_id: other.account.user.id,
        actor_email: other.account.user.email,
      });
    });
  });

  describe("DELETE …/configurations/:configurationId", () => {
    it("deletes softly: 204, deleted_at and updated_at the clock's, the audit row, and it leaves the list", async () => {
      const { account, organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "Doomed");
      await created(access, organization.id, "Kept");
      tick();

      const response = await remove(access, organization.id, configuration.id);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(await configurationRow(configuration.id)).toMatchObject({ deleted_at: clock, updated_at: clock });
      expect((await configurationAudits()).at(-1)).toMatchObject({
        action: "configuration.deleted",
        actor_user_id: account.user.id,
        organization_id: organization.id,
        subject_type: "configuration",
        subject_id: configuration.id,
        metadata: { name: "Doomed" },
      });
      expect(names(await page(access, organization.id))).toEqual(["Kept"]);
    });

    it("answers a second delete, and a rename after it, 404 configuration_not_found, writing nothing", async () => {
      const { organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "Doomed");
      expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
      const before = await snapshot();
      tick();

      expectRefusal(
        await remove(access, organization.id, configuration.id),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expectRefusal(
        await change(access, organization.id, configuration.id, { name: "Back" }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("who may do what", () => {
    it("lets a contributor create, and rename an admin's published configuration, but not delete it: 403 configuration_delete_forbidden, writing nothing", async () => {
      const admin = await memberActiveInGroup("admin");
      const contributor = await memberActiveInGroup("contributor", admin.group.id);
      const theirs = await created(admin.access, admin.group.id, "Theirs");
      await publish(theirs.id);

      expect((await create(contributor.access, admin.group.id, { name: "Mine" })).statusCode).toBe(201);
      const renamed = await change(contributor.access, admin.group.id, theirs.id, { name: "Renamed" });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ configuration: { name: "Renamed", published: true } });
      const before = await snapshot();
      tick();

      expectRefusal(
        await remove(contributor.access, admin.group.id, theirs.id),
        403,
        "configuration_delete_forbidden",
        MESSAGES.deleteForbidden,
      );
      expect(await snapshot()).toEqual(before);
      expect(names(await page(admin.access, admin.group.id))).toEqual(["Renamed"]);
    });

    it("lets an admin delete a contributor's published configuration", async () => {
      const contributor = await memberActiveInGroup("admin");
      const admin = await memberActiveInGroup("admin", contributor.group.id);
      await ownerDb
        .updateTable("organization_members")
        .set({ role: "contributor" })
        .where("user_id", "=", contributor.account.user.id)
        .where("organization_id", "=", contributor.group.id)
        .execute();
      const theirs = await created(contributor.access, contributor.group.id, "Theirs");
      await publish(theirs.id);

      const response = await remove(admin.access, contributor.group.id, theirs.id);

      expect(response.statusCode).toBe(204);
      expect(await configurationRow(theirs.id)).toMatchObject({ deleted_at: clock });
      expect((await configurationAudits()).at(-1)).toMatchObject({
        action: "configuration.deleted",
        actor_user_id: admin.account.user.id,
        subject_id: theirs.id,
      });
    });

    it("lets the author delete their own, a contributor's draft or published", async () => {
      const admin = await memberActiveInGroup("admin");
      const author = await memberActiveInGroup("contributor", admin.group.id);
      const draft = await created(author.access, admin.group.id, "Draft");
      const published = await created(author.access, admin.group.id, "Published");
      await publish(published.id);

      expect((await remove(author.access, admin.group.id, draft.id)).statusCode).toBe(204);
      expect((await remove(author.access, admin.group.id, published.id)).statusCode).toBe(204);
      expect(names(await page(admin.access, admin.group.id))).toEqual([]);
    });

    it("lets only an admin delete a published configuration whose author's account is gone", async () => {
      const admin = await memberActiveInGroup("admin");
      const contributor = await memberActiveInGroup("contributor", admin.group.id);
      const orphan = await addConfiguration(ownerDb, { organizationId: admin.group.id, name: "Orphan" });
      await addConfigurationVersion(ownerDb, {
        configurationId: orphan.id,
        organizationId: admin.group.id,
        publishedAt: clock,
      });

      expectRefusal(
        await remove(contributor.access, admin.group.id, orphan.id),
        403,
        "configuration_delete_forbidden",
        MESSAGES.deleteForbidden,
      );
      expect((await remove(admin.access, admin.group.id, orphan.id)).statusCode).toBe(204);
    });

    it("reads the role under the lock: a contributor promoted since signing in deletes, an admin demoted since doesn't", async () => {
      const author = await memberActiveInGroup("admin");
      const promoted = await memberActiveInGroup("contributor", author.group.id);
      const demoted = await memberActiveInGroup("admin", author.group.id);
      const configuration = await created(author.access, author.group.id, "Theirs");
      await publish(configuration.id);
      const setRole = (userId: string, role: OrganizationRole) =>
        ownerDb
          .updateTable("organization_members")
          .set({ role })
          .where("user_id", "=", userId)
          .where("organization_id", "=", author.group.id)
          .execute();
      await setRole(promoted.account.user.id, "admin");
      await setRole(demoted.account.user.id, "contributor");

      expectRefusal(
        await remove(demoted.access, author.group.id, configuration.id),
        403,
        "configuration_delete_forbidden",
        MESSAGES.deleteForbidden,
      );
      expect((await remove(promoted.access, author.group.id, configuration.id)).statusCode).toBe(204);
    });
  });

  describe("another member's draft is invisible", () => {
    /**
     * A's draft with versions 1 and 2, and B, A's teammate, an admin: an
     * admin sees no one else's draft either.
     */
    const draftOfAnother = async () => {
      const a = await memberActiveInGroup("contributor");
      const b = await memberActiveInGroup("admin", a.group.id);
      const configuration = await created(a.access, a.group.id, "A's draft");
      const first = await versionOf(configuration.id);
      const second = await newVersion(a.access, a.group.id, configuration.id, {
        sourceVersionId: first.id,
        label: "Second",
        yamlContent: "second\n",
        ...EMPTY_GRAPH,
      });
      expect(second.statusCode).toBe(201);
      return { a, b, group: a.group, configuration, first, second: second.json<{ version: VersionBody }>().version };
    };

    it("leaves it out of the list, whatever the filter", async () => {
      const { b, group } = await draftOfAnother();
      for (const query of ["", "?filter=all", "?filter=mine", "?filter=published"]) {
        expect(names(await page(b.access, group.id, query))).toEqual([]);
      }
    });

    it("answers every route naming it 404 configuration_not_found, as for one that doesn't exist, writing nothing", async () => {
      const { b, group, configuration, first, second } = await draftOfAnother();
      const before = await snapshot();
      tick();

      const responses = [
        await read(b.access, group.id, configuration.id),
        await readVersion(b.access, group.id, configuration.id, first.id),
        await listVersions(b.access, group.id, configuration.id),
        await listVersions(b.access, group.id, configuration.id, "?filter=published"),
        await newVersion(b.access, group.id, configuration.id, {
          sourceVersionId: first.id,
          yamlContent: "slipped in",
          ...EMPTY_GRAPH,
        }),
        await save(b.access, group.id, configuration.id, second.id, { yamlContent: "taken", ...EMPTY_GRAPH }),
        await renameVersion(b.access, group.id, configuration.id, second.id, { label: "Taken" }),
        await selectVersion(b.access, group.id, configuration.id, { versionId: first.id }),
        await change(b.access, group.id, configuration.id, { name: "Taken" }),
        await remove(b.access, group.id, configuration.id),
      ];
      for (const response of responses) {
        expectRefusal(response, 404, "configuration_not_found", MESSAGES.configurationNotFound);
      }
      expect(await snapshot()).toEqual(before);
      // And the same answers as for an id that names nothing.
      const unknown = randomUUID();
      expectRefusal(
        await read(b.access, group.id, unknown),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expectRefusal(
        await remove(b.access, group.id, unknown),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
    });

    it("shows it to its author on every route", async () => {
      const { a, group, configuration, first, second } = await draftOfAnother();
      expect(names(await page(a.access, group.id))).toEqual(["A's draft"]);
      expect((await read(a.access, group.id, configuration.id)).statusCode).toBe(200);
      expect((await readVersion(a.access, group.id, configuration.id, second.id)).statusCode).toBe(200);
      expect((await listVersions(a.access, group.id, configuration.id)).json()).toEqual({
        versions: [
          { id: second.id, versionNumber: 2, label: "Second", publishedAt: null },
          { id: first.id, versionNumber: 1, label: null, publishedAt: null },
        ],
      });
    });
  });

  describe("a published configuration", () => {
    /**
     * A's configuration with version 1 published by A and a draft version
     * 2; B, A's teammate, a contributor.
     */
    const publishedOfAnother = async () => {
      const a = await memberActiveInGroup("admin");
      const b = await memberActiveInGroup("contributor", a.group.id);
      const configuration = await created(a.access, a.group.id, "A's published");
      const publishedAt = await publish(configuration.id, 1, a.account.user.id);
      const first = await versionOf(configuration.id);
      const second = await newVersion(a.access, a.group.id, configuration.id, {
        sourceVersionId: first.id,
        label: "Draft",
        yamlContent: "draft\n",
        ...EMPTY_GRAPH,
      });
      expect(second.statusCode).toBe(201);
      tick();
      return {
        a,
        b,
        group: a.group,
        configuration,
        publishedAt,
        first,
        second: second.json<{ version: VersionBody }>().version,
      };
    };

    it("works for a teammate on every route but delete: list, read, read each version, create, save and rename its draft version, select, rename it", async () => {
      const { a, b, group, configuration, publishedAt, first, second } = await publishedOfAnother();

      const listed = await page(b.access, group.id);
      expect(listed.items).toEqual([expect.objectContaining({ id: configuration.id, published: true })]);
      const opened = await read(b.access, group.id, configuration.id);
      expect(opened.statusCode).toBe(200);
      expect(
        opened.json<WithVersionBody>().versions.map((version) => [version.versionNumber, version.publishedAt]),
      ).toEqual([
        [2, null],
        [1, publishedAt.toISOString()],
      ]);
      expect(opened.json<WithVersionBody>().versions[1]!.publishedBy).toEqual({
        userId: a.account.user.id,
        email: a.account.user.email,
      });
      for (const version of [first.id, second.id]) {
        expect((await readVersion(b.access, group.id, configuration.id, version)).statusCode).toBe(200);
      }
      const versionsListed = await listVersions(b.access, group.id, configuration.id);
      expect(versionsListed.statusCode).toBe(200);
      expect(versionsListed.json()).toEqual({
        versions: [
          { id: second.id, versionNumber: 2, label: "Draft", publishedAt: null },
          { id: first.id, versionNumber: 1, label: null, publishedAt: publishedAt.toISOString() },
        ],
      });
      // A new version from the published one: a draft.
      const third = await newVersion(b.access, group.id, configuration.id, {
        sourceVersionId: first.id,
        yamlContent: "copied\n",
        ...EMPTY_GRAPH,
      });
      expect(third.statusCode).toBe(201);
      expect(third.json<{ version: VersionBody }>().version).toMatchObject({
        versionNumber: 3,
        publishedAt: null,
        publishedBy: null,
        ...pinned,
      });
      expect(
        (await save(b.access, group.id, configuration.id, second.id, { yamlContent: "saved by B\n", ...EMPTY_GRAPH }))
          .statusCode,
      ).toBe(200);
      expect((await renameVersion(b.access, group.id, configuration.id, second.id, { label: "B's" })).statusCode).toBe(
        200,
      );
      expect((await selectVersion(b.access, group.id, configuration.id, { versionId: first.id })).statusCode).toBe(204);
      expect((await change(b.access, group.id, configuration.id, { name: "Renamed by B" })).statusCode).toBe(200);
      expectRefusal(
        await remove(b.access, group.id, configuration.id),
        403,
        "configuration_delete_forbidden",
        MESSAGES.deleteForbidden,
      );
      expect(await configurationRow(configuration.id)).toMatchObject({ name: "Renamed by B", deleted_at: null });
    });

    it.each(["teammate", "author"] as const)(
      "answers the %s's save of the published version 409 configuration_version_published, writing and auditing nothing",
      async (who) => {
        const { a, b, group, configuration, first } = await publishedOfAnother();
        const actor = who === "teammate" ? b : a;
        const before = await snapshot();

        expectRefusal(
          await save(actor.access, group.id, configuration.id, first.id, { yamlContent: "changed\n", ...EMPTY_GRAPH }),
          409,
          "configuration_version_published",
          MESSAGES.versionPublished,
        );
        expect(await snapshot()).toEqual(before);
      },
    );

    it.each([
      ["a new label", "Renamed"],
      ["its own label", "Released"],
    ] as const)(
      "answers a relabel of the published version to %s 409 configuration_version_published, writing and auditing nothing",
      async (_how, label) => {
        const a = await memberActiveInGroup("admin");
        const configuration = await created(a.access, a.group.id, "Released one");
        // Named before it is published: a published version's label is fixed.
        await ownerDb
          .updateTable("configuration_versions")
          .set({ label: "Released" })
          .where("configuration_id", "=", configuration.id)
          .execute();
        await publish(configuration.id);
        const first = await versionOf(configuration.id);
        const before = await snapshot();

        expectRefusal(
          await renameVersion(a.access, a.group.id, configuration.id, first.id, { label }),
          409,
          "configuration_version_published",
          MESSAGES.versionPublished,
        );
        expect(await snapshot()).toEqual(before);
      },
    );

    it("answers an invalid body to a published version's save 400 invalid_request, as for any version: the contract runs before the service", async () => {
      const { a, group, configuration, first } = await publishedOfAnother();
      expectInvalid(await save(a.access, group.id, configuration.id, first.id, { yamlContent: 42, ...EMPTY_GRAPH }));
    });
  });

  describe("refusals, each writing nothing", () => {
    /**
     * A user who belongs to a group organization with a configuration, and
     * is active in their personal organization: the group is another
     * organization, although they are a member of it.
     */
    const memberOfBoth = async () => {
      const inGroup = await memberActiveInGroup("admin");
      const groupConfiguration = await created(inGroup.access, inGroup.group.id, "The group's");
      const access = await switchTo(inGroup.access, inGroup.personal.id);
      const personalConfiguration = await created(access, inGroup.personal.id, "Mine");
      return { ...inGroup, access, groupConfiguration, personalConfiguration };
    };

    describe("another organization than the active one: 404 organization_not_found", () => {
      it("listing it, even as a member of it, answers nothing from either organization", async () => {
        const { group, access } = await memberOfBoth();
        expectRefusal(await list(access, group.id), 404, "organization_not_found", MESSAGES.organizationNotFound);
      });

      it("creating in it, even as a member of it", async () => {
        const { group, access } = await memberOfBoth();
        const before = await snapshot();
        expectRefusal(
          await create(access, group.id, { name: "Sneaky" }),
          404,
          "organization_not_found",
          MESSAGES.organizationNotFound,
        );
        expect(await snapshot()).toEqual(before);
      });

      it("reading or saving its own configuration through it, even as a member of it", async () => {
        const { group, access, groupConfiguration } = await memberOfBoth();
        const version = await versionOf(groupConfiguration.id);
        const before = await snapshot();
        expectRefusal(
          await read(access, group.id, groupConfiguration.id),
          404,
          "organization_not_found",
          MESSAGES.organizationNotFound,
        );
        expectRefusal(
          await save(access, group.id, groupConfiguration.id, version.id, { yamlContent: "sneaky", ...EMPTY_GRAPH }),
          404,
          "organization_not_found",
          MESSAGES.organizationNotFound,
        );
        expect(await snapshot()).toEqual(before);
      });

      it("reading a version of its own configuration, or creating, renaming or selecting one, through it, even as a member of it", async () => {
        const { group, access, groupConfiguration } = await memberOfBoth();
        const version = await versionOf(groupConfiguration.id);
        const before = await snapshot();
        for (const response of [
          await readVersion(access, group.id, groupConfiguration.id, version.id),
          await listVersions(access, group.id, groupConfiguration.id),
          await newVersion(access, group.id, groupConfiguration.id, {
            sourceVersionId: version.id,
            yamlContent: "sneaky",
            ...EMPTY_GRAPH,
          }),
          await renameVersion(access, group.id, groupConfiguration.id, version.id, { label: "Sneaky" }),
          await selectVersion(access, group.id, groupConfiguration.id, { versionId: version.id }),
        ]) {
          expectRefusal(response, 404, "organization_not_found", MESSAGES.organizationNotFound);
        }
        expect(await snapshot()).toEqual(before);
      });

      it("renaming or deleting its own configuration through it, even as a member of it", async () => {
        const { group, access, groupConfiguration } = await memberOfBoth();
        const before = await snapshot();
        expectRefusal(
          await change(access, group.id, groupConfiguration.id, { name: "Sneaky" }),
          404,
          "organization_not_found",
          MESSAGES.organizationNotFound,
        );
        expectRefusal(
          await remove(access, group.id, groupConfiguration.id),
          404,
          "organization_not_found",
          MESSAGES.organizationNotFound,
        );
        expect(await snapshot()).toEqual(before);
      });

      it("naming an organization the caller doesn't belong to, or no organization at all", async () => {
        const { access, personalConfiguration } = await memberOfBoth();
        const personalVersion = await versionOf(personalConfiguration.id);
        const stranger = await personalUser();
        const before = await snapshot();
        for (const organizationId of [stranger.organization.id, randomUUID(), "not-a-uuid"]) {
          expectRefusal(
            await list(access, organizationId),
            404,
            "organization_not_found",
            MESSAGES.organizationNotFound,
          );
          expectRefusal(
            await create(access, organizationId, { name: "Sneaky" }),
            404,
            "organization_not_found",
            MESSAGES.organizationNotFound,
          );
          expectRefusal(
            await change(access, organizationId, personalConfiguration.id, { name: "Sneaky" }),
            404,
            "organization_not_found",
            MESSAGES.organizationNotFound,
          );
          expectRefusal(
            await read(access, organizationId, personalConfiguration.id),
            404,
            "organization_not_found",
            MESSAGES.organizationNotFound,
          );
          expectRefusal(
            await save(access, organizationId, personalConfiguration.id, personalVersion.id, {
              yamlContent: "sneaky",
              ...EMPTY_GRAPH,
            }),
            404,
            "organization_not_found",
            MESSAGES.organizationNotFound,
          );
          for (const response of [
            await readVersion(access, organizationId, personalConfiguration.id, personalVersion.id),
            await listVersions(access, organizationId, personalConfiguration.id),
            await newVersion(access, organizationId, personalConfiguration.id, {
              sourceVersionId: personalVersion.id,
              yamlContent: "sneaky",
              ...EMPTY_GRAPH,
            }),
            await renameVersion(access, organizationId, personalConfiguration.id, personalVersion.id, {
              label: "Sneaky",
            }),
            await selectVersion(access, organizationId, personalConfiguration.id, { versionId: personalVersion.id }),
          ]) {
            expectRefusal(response, 404, "organization_not_found", MESSAGES.organizationNotFound);
          }
        }
        expect(await snapshot()).toEqual(before);
      });
    });

    it("another organization's configuration, through the caller's own organization: 404 configuration_not_found", async () => {
      const { personal, access, groupConfiguration } = await memberOfBoth();
      const groupVersion = await versionOf(groupConfiguration.id);
      const before = await snapshot();

      expectRefusal(
        await read(access, personal.id, groupConfiguration.id),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expectRefusal(
        await save(access, personal.id, groupConfiguration.id, groupVersion.id, {
          yamlContent: "sneaky",
          ...EMPTY_GRAPH,
        }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );

      expectRefusal(
        await change(access, personal.id, groupConfiguration.id, { name: "Sneaky" }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expectRefusal(
        await remove(access, personal.id, groupConfiguration.id),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      for (const response of [
        await readVersion(access, personal.id, groupConfiguration.id, groupVersion.id),
        await listVersions(access, personal.id, groupConfiguration.id),
        await newVersion(access, personal.id, groupConfiguration.id, {
          sourceVersionId: groupVersion.id,
          yamlContent: "sneaky",
          ...EMPTY_GRAPH,
        }),
        await renameVersion(access, personal.id, groupConfiguration.id, groupVersion.id, { label: "Sneaky" }),
        await selectVersion(access, personal.id, groupConfiguration.id, { versionId: groupVersion.id }),
      ]) {
        expectRefusal(response, 404, "configuration_not_found", MESSAGES.configurationNotFound);
      }
      expect(names(await page(access, personal.id))).toEqual(["Mine"]);
      expect(await snapshot()).toEqual(before);
    });

    it("another organization's version as the source or the selection, through the caller's own configuration: 404 configuration_version_not_found", async () => {
      const { personal, access, groupConfiguration, personalConfiguration } = await memberOfBoth();
      const groupVersion = await versionOf(groupConfiguration.id);
      const before = await snapshot();
      for (const response of [
        await readVersion(access, personal.id, personalConfiguration.id, groupVersion.id),
        await newVersion(access, personal.id, personalConfiguration.id, {
          sourceVersionId: groupVersion.id,
          yamlContent: "sneaky",
          ...EMPTY_GRAPH,
        }),
        await renameVersion(access, personal.id, personalConfiguration.id, groupVersion.id, { label: "Sneaky" }),
        await selectVersion(access, personal.id, personalConfiguration.id, { versionId: groupVersion.id }),
      ]) {
        expectRefusal(response, 404, "configuration_version_not_found", MESSAGES.versionNotFound);
      }
      expect(await snapshot()).toEqual(before);
    });

    it.each(["not-a-uuid", "42", "0192F1A47B3C7D2E8F101A2B3C4D5E6F", "%7B0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f%7D"])(
      "a malformed configuration id (%s): 404 configuration_not_found",
      async (id) => {
        const { organization, access } = await personalUser();
        const present = await created(access, organization.id, "Present");
        const version = await versionOf(present.id);
        const before = await snapshot();
        expectRefusal(
          await save(access, organization.id, id, version.id, { yamlContent: "X", ...EMPTY_GRAPH }),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
        expectRefusal(
          await change(access, organization.id, id, { name: "X" }),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
        expectRefusal(
          await remove(access, organization.id, id),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
        expect(await snapshot()).toEqual(before);
      },
    );

    it("an unknown configuration id: 404 configuration_not_found", async () => {
      const { organization, access } = await personalUser();
      const id = randomUUID();
      expectRefusal(
        await save(access, organization.id, id, randomUUID(), { yamlContent: "X", ...EMPTY_GRAPH }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expectRefusal(
        await change(access, organization.id, id, { name: "X" }),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expectRefusal(
        await remove(access, organization.id, id),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
    });

    /**
     * Each endpoint, called by `access` (none: signed out) on the caller's
     * organization, its configuration and its version.
     */
    const endpoints = [
      ["GET (list)", (access: string | undefined, organizationId: string) => list(access, organizationId)],
      [
        "GET (read)",
        (access: string | undefined, organizationId: string, configurationId: string) =>
          read(access, organizationId, configurationId),
      ],
      [
        "POST (create)",
        (access: string | undefined, organizationId: string) => create(access, organizationId, { name: "New" }),
      ],
      [
        "PATCH (change)",
        (access: string | undefined, organizationId: string, configurationId: string) =>
          change(access, organizationId, configurationId, { name: "Changed" }),
      ],
      [
        "DELETE (delete)",
        (access: string | undefined, organizationId: string, configurationId: string) =>
          remove(access, organizationId, configurationId),
      ],
      [
        "PATCH (save a version)",
        (access: string | undefined, organizationId: string, configurationId: string, versionId: string) =>
          save(access, organizationId, configurationId, versionId, { yamlContent: "saved\n", ...EMPTY_GRAPH }),
      ],
      [
        "GET (read a version)",
        (access: string | undefined, organizationId: string, configurationId: string, versionId: string) =>
          readVersion(access, organizationId, configurationId, versionId),
      ],
      [
        "GET (list the versions)",
        (access: string | undefined, organizationId: string, configurationId: string) =>
          listVersions(access, organizationId, configurationId),
      ],
      [
        "POST (create a version)",
        (access: string | undefined, organizationId: string, configurationId: string, versionId: string) =>
          newVersion(access, organizationId, configurationId, {
            sourceVersionId: versionId,
            yamlContent: "created\n",
            ...EMPTY_GRAPH,
          }),
      ],
      [
        "PUT (rename a version)",
        (access: string | undefined, organizationId: string, configurationId: string, versionId: string) =>
          renameVersion(access, organizationId, configurationId, versionId, { label: "Renamed" }),
      ],
      [
        "PUT (select a version)",
        (access: string | undefined, organizationId: string, configurationId: string, versionId: string) =>
          selectVersion(access, organizationId, configurationId, { versionId }),
      ],
    ] as const;

    it.each(endpoints)("%s signed out: 401 unauthenticated", async (_name, call) => {
      const { organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "Present");
      const version = await versionOf(configuration.id);
      const before = await snapshot();
      expectRefusal(
        await call(undefined, organization.id, configuration.id, version.id),
        401,
        "unauthenticated",
        MESSAGES.unauthenticated,
      );
      expect(await snapshot()).toEqual(before);
    });

    it.each(endpoints)(
      "%s by a user who hasn't accepted the current terms: 403 terms_acceptance_required",
      async (_name, call) => {
        const { organization, access } = await personalUser({ user: { accepted_terms_version: "2025-01-01" } });
        const configuration = await addConfiguration(ownerDb, { organizationId: organization.id, name: "Present" });
        const version = await addConfigurationVersion(ownerDb, {
          configurationId: configuration.id,
          organizationId: organization.id,
        });
        const before = await snapshot();

        expectRefusal(
          await call(access, organization.id, configuration.id, version.id),
          403,
          "terms_acceptance_required",
          MESSAGES.terms,
        );
        expect(await snapshot()).toEqual(before);
      },
    );

    it.each([
      [
        "POST (create)",
        (access: string, organizationId: string, _id: string) => create(access, organizationId, { name: "New" }, {}),
      ],
      [
        "PATCH (change)",
        (access: string, organizationId: string, id: string) =>
          change(access, organizationId, id, { name: "Changed" }, {}),
      ],
      [
        "DELETE (delete)",
        (access: string, organizationId: string, id: string) => remove(access, organizationId, id, {}),
      ],
      [
        "PATCH (save a version)",
        (access: string, organizationId: string, id: string, versionId: string) =>
          save(access, organizationId, id, versionId, { yamlContent: "saved\n", ...EMPTY_GRAPH }, {}),
      ],
      [
        "POST (create a version)",
        (access: string, organizationId: string, id: string, versionId: string) =>
          newVersion(access, organizationId, id, { sourceVersionId: versionId, yamlContent: "", ...EMPTY_GRAPH }, {}),
      ],
      [
        "PUT (rename a version)",
        (access: string, organizationId: string, id: string, versionId: string) =>
          renameVersion(access, organizationId, id, versionId, { label: "Renamed" }, {}),
      ],
      [
        "PUT (select a version)",
        (access: string, organizationId: string, id: string, versionId: string) =>
          selectVersion(access, organizationId, id, { versionId }, {}),
      ],
    ] as const)("%s without the CSRF header: 403 csrf_header_missing", async (_name, call) => {
      const { organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "Present");
      const version = await versionOf(configuration.id);
      const before = await snapshot();
      expectRefusal(
        await call(access, organization.id, configuration.id, version.id),
        403,
        "csrf_header_missing",
        MESSAGES.csrf,
      );
      expect(await snapshot()).toEqual(before);
    });

    it.each([
      ["a missing name", {}],
      ["an empty name", { name: "   " }],
      ["a 201-character name", { name: "a".repeat(201) }],
      ["a 501-character description", { name: "A", description: "a".repeat(501) }],
      ["a null description", { name: "A", description: null }],
      ["a yaml field", { name: "A", yaml: "receivers: {}" }],
      // Postgres can't store these exactly: 400, never a 500 or a U+FFFD stored.
      ["U+0000 in the name", { name: "Gate\u0000way" }],
      ["a lone surrogate in the name", { name: "Gate\ud800way" }],
      ["U+0000 in the description", { name: "A", description: "Edge\u0000" }],
      ["a lone surrogate in the description", { name: "A", description: "Edge\udc00" }],
    ])("creating with %s: 400 invalid_request", async (_label, payload) => {
      const { organization, access } = await personalUser();
      const before = await snapshot();
      expectInvalid(await create(access, organization.id, payload));
      expect(await snapshot()).toEqual(before);
    });

    it("creating with an empty name says why in the details", async () => {
      const { organization, access } = await personalUser();
      const response = await create(access, organization.id, { name: "" });
      expectInvalid(response);
      expect(JSON.stringify(response.json())).toContain("Configuration name cannot be empty");
    });

    it.each([
      ["an empty name", { name: "" }],
      ["a null name", { name: null }],
      ["a null description", { description: null }],
      ["a 201-character name", { name: "a".repeat(201) }],
      ["a yaml field", { yaml: "receivers: {}" }],
      ["U+0000 in the name", { name: "Re\u0000named" }],
      ["a lone surrogate in the name", { name: "Re\ud800named" }],
      ["U+0000 in the description", { description: "Edge\u0000" }],
      ["a lone surrogate in the description", { description: "Edge\udc00" }],
    ])("changing with %s: 400 invalid_request", async (_label, payload) => {
      const { organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "Present");
      const before = await snapshot();
      expectInvalid(await change(access, organization.id, configuration.id, payload));
      expect(await snapshot()).toEqual(before);
    });

    describe("saving a version", () => {
      const withVersion = async () => {
        const user = await personalUser();
        const configuration = await created(user.access, user.organization.id, "Present");
        const version = await versionOf(configuration.id);
        tick();
        return { ...user, configuration, version };
      };

      it("of a deleted configuration: 404 configuration_not_found", async () => {
        const { organization, access, configuration, version } = await withVersion();
        expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
        const before = await snapshot();
        expectRefusal(
          await save(access, organization.id, configuration.id, version.id, { yamlContent: "X", ...EMPTY_GRAPH }),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
        expect(await snapshot()).toEqual(before);
      });

      it("naming a version of another configuration in the same organization: 404 configuration_not_found", async () => {
        const { organization, access, configuration } = await withVersion();
        const other = await created(access, organization.id, "Other");
        const othersVersion = await versionOf(other.id);
        const before = await snapshot();
        expectRefusal(
          await save(access, organization.id, configuration.id, othersVersion.id, { yamlContent: "X", ...EMPTY_GRAPH }),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
        expect(await snapshot()).toEqual(before);
      });

      it.each(["not-a-uuid", "42", "0192F1A47B3C7D2E8F101A2B3C4D5E6F", "%7B0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f%7D"])(
        "naming a malformed version id (%s): 404 configuration_not_found",
        async (versionId) => {
          const { organization, access, configuration } = await withVersion();
          const before = await snapshot();
          expectRefusal(
            await save(access, organization.id, configuration.id, versionId, { yamlContent: "X", ...EMPTY_GRAPH }),
            404,
            "configuration_not_found",
            MESSAGES.configurationNotFound,
          );
          expect(await snapshot()).toEqual(before);
        },
      );

      it("naming an unknown version: 404 configuration_not_found", async () => {
        const { organization, access, configuration } = await withVersion();
        const before = await snapshot();
        expectRefusal(
          await save(access, organization.id, configuration.id, randomUUID(), { yamlContent: "X", ...EMPTY_GRAPH }),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
        expect(await snapshot()).toEqual(before);
      });

      it.each([
        ["262,145 characters", { yamlContent: "a".repeat(262_145), ...EMPTY_GRAPH }],
        ["a missing yamlContent", { ...EMPTY_GRAPH }],
        ["a null yamlContent", { yamlContent: null, ...EMPTY_GRAPH }],
        ["a number", { yamlContent: 42, ...EMPTY_GRAPH }],
        ["an unknown field", { yamlContent: "", ...EMPTY_GRAPH, versionNumber: 2 }],
        [
          "U+0000, which Postgres can't store",
          { yamlContent: "receivers:\u0000", ...EMPTY_GRAPH },
        ],
        [
          "a lone surrogate, which isn't well formed",
          { yamlContent: "receivers: \ud83d", ...EMPTY_GRAPH },
        ],
        ["the text alone, a text-only save", { yamlContent: "receivers: {}\n" }],
        ["a missing nodes", { yamlContent: "", edges: [], pipelines: [] }],
        ["a missing edges", { yamlContent: "", nodes: [], pipelines: [] }],
        ["a missing pipelines", { yamlContent: "", nodes: [], edges: [] }],
        ["nodes as an object", { yamlContent: "", ...EMPTY_GRAPH, nodes: {} }],
        ["pipelines as null", { yamlContent: "", ...EMPTY_GRAPH, pipelines: null }],
      ])("with %s: 400 invalid_request", async (_label, payload) => {
        const { organization, access, configuration, version } = await withVersion();
        const before = await snapshot();
        expectInvalid(await save(access, organization.id, configuration.id, version.id, payload));
        expect(await snapshot()).toEqual(before);
      });

      /** The graph with its first pipeline changed. */
      const graphWithPipeline = (change: (pipeline: Record<string, unknown>) => void) => {
        const graph = structuredClone(GRAPH);
        change(graph.pipelines[0] as Record<string, unknown>);
        return graph;
      };
      /** A config string that makes the nodes column `bytes` long in UTF-8, in `unit`s. */
      const nodesOfBytes = (bytes: number, unit: string) => {
        const empty = Buffer.byteLength(JSON.stringify(graphWithReceiver((node) => (node.data.config = "")).nodes));
        const count = Math.floor((bytes - empty) / Buffer.byteLength(unit));
        return graphWithReceiver((node) => (node.data.config = unit.repeat(count)));
      };

      it.each([
        [
          "a group id carrying the pipeline's name",
          () => ({ ...GRAPH, nodes: [{ ...GRAPH.nodes[0], id: "group-pipeline-traces" }] }),
        ],
        ["a component id carrying a name", () => graphWithReceiver((node) => (node.id = "receiver-otlp-1"))],
        ["a parent named by a name", () => graphWithReceiver((node) => (node.parentId = "group-pipeline-traces"))],
        ["an edge id carrying a name", () => ({ ...GRAPH, edges: [{ ...GRAPH.edges[0], id: "edge-otlp-debug" }] })],
        ["a pipeline id carrying its name", () => graphWithPipeline((pipeline) => (pipeline.id = "traces-production"))],
        ["an unknown field", () => graphWithReceiver((node) => (node.data.unknown = true))],
        ["React Flow's measured", () => graphWithReceiver((node) => (node.measured = { width: 10, height: 10 }))],
        ["React Flow's selected", () => graphWithReceiver((node) => (node.selected = true))],
        ["a position beyond ±1,000,000", () => graphWithReceiver((node) => (node.position.x = 1_000_001))],
        ["a bad colour", () => graphWithPipeline((pipeline) => (pipeline.color = "orange"))],
        ["an unknown signal", () => graphWithPipeline((pipeline) => (pipeline.signalType = "profiles"))],
        [
          "5,001 nodes",
          () => ({
            ...GRAPH,
            nodes: Array.from({ length: 5_001 }, (_, index) => ({ ...RECEIVER, id: `node_${index}` })),
          }),
        ],
        ["a nodes column one byte over 1 MiB", () => nodesOfBytes(GRAPH_COLUMN_BYTES + 1, "a")],
        [
          "a nodes column under 1 MiB in UTF-16 units but over it in UTF-8 bytes",
          () => nodesOfBytes(GRAPH_COLUMN_BYTES + 3, "中"),
        ],
        [
          "U+0000 in a nested config string",
          () => graphWithReceiver((node) => (node.data.config = { a: [{ b: "x\u0000y" }] })),
        ],
        [
          "a lone surrogate in a nested config key",
          () => graphWithReceiver((node) => (node.data.config = { a: { "\ud800": 1 } })),
        ],
        ["a lone surrogate in a label", () => graphWithReceiver((node) => (node.data.label = "\udfff"))],
      ])("with %s in the graph: 400 invalid_request, writing nothing", async (_label, graphOf) => {
        const { organization, access, configuration, version } = await withVersion();
        const before = await snapshot();
        expectInvalid(
          await save(access, organization.id, configuration.id, version.id, {
            yamlContent: "receivers: {}\n",
            ...graphOf(),
          }),
        );
        expect(await snapshot()).toEqual(before);
      });

      it("with a non-finite position, which JSON writes as 1e400: 400 invalid_request", async () => {
        const { organization, access, configuration, version } = await withVersion();
        const body = JSON.stringify({ yamlContent: "", ...GRAPH }).replace('"x":50.5', '"x":1e400');
        expect(body).toContain("1e400");
        const before = await snapshot();
        expectInvalid(await save(access, organization.id, configuration.id, version.id, body));
        expect(await snapshot()).toEqual(before);
      });

      it("with a body over 5 MiB: 413 payload_too_large", async () => {
        const { organization, access, configuration, version } = await withVersion();
        const body = JSON.stringify({ yamlContent: "\u0001".repeat(900_000), ...EMPTY_GRAPH });
        expect(body.length).toBeGreaterThan(SAVE_BODY_LIMIT);
        const before = await snapshot();
        expectRefusal(
          await save(access, organization.id, configuration.id, version.id, body),
          413,
          "payload_too_large",
          MESSAGES.tooLarge,
        );
        expect(await snapshot()).toEqual(before);
      });

      it("keeps the server's 1 MiB on the other routes: the 5 MiB is the save's and the create's alone", async () => {
        const { organization, access, configuration, version } = await withVersion();
        const body = JSON.stringify({ description: "\u0001".repeat(200_000) });
        expect(body.length).toBeGreaterThan(1_048_576);
        for (const [method, url] of [
          ["PATCH", path(organization.id, configuration.id)],
          ["PUT", `${path(organization.id, configuration.id)}/versions/${version.id}/label`],
          ["PUT", `${path(organization.id, configuration.id)}/selected-version`],
        ] as const) {
          const response = await server.inject({
            method,
            url,
            headers: { ...csrfHeaders, "content-type": "application/json" },
            cookies: { telflo_access: access },
            payload: body,
          });
          expectRefusal(response, 413, "payload_too_large", MESSAGES.tooLarge);
        }
      });
    });
  });

  describe("collector distributions and versions", () => {
    const VERSION_UNKNOWN = ["collector_version_unknown", "That collector version isn't available."] as const;
    const DISTRIBUTION_UNKNOWN = ["collector_distribution_unknown", "That collector distribution isn't available."] as const;

    /** A save's body: the version's content as it is, and `extra`. */
    const saveBody = (yamlContent: string, extra: Record<string, unknown> = {}) => ({
      yamlContent,
      ...EMPTY_GRAPH,
      ...extra,
    });

    describe("creating a configuration", () => {
      it("with no distribution: the catalog's default, which the configuration carries, its version 1 at that distribution's default version", async () => {
        const { organization, access } = await personalUser();

        const configuration = await created(access, organization.id, "Gateway");

        expect(configuration.collectorDistribution).toBe(pin.distribution);
        const body = (await read(access, organization.id, configuration.id)).json<WithVersionBody>();
        expect(body.configuration.collectorDistribution).toBe(pin.distribution);
        expect(body.version).toMatchObject(pinned);
        expect(body.versions).toEqual([expect.objectContaining(pinned)]);
      });

      it("with Contrib named: 201, built for it, its version 1 at Contrib's default version as the tables hold it", async () => {
        const { organization, access } = await personalUser();
        const contribDefault = await ownerDb
          .selectFrom("collector_versions")
          .select("version")
          .where("distribution", "=", "otelcol-contrib")
          .where("is_default", "=", true)
          .executeTakeFirstOrThrow();

        const response = await create(access, organization.id, { name: "Gateway", collectorDistribution: "otelcol-contrib" });

        expect(response.statusCode).toBe(201);
        const { configuration } = response.json<{ configuration: ConfigurationBody }>();
        expect(configuration.collectorDistribution).toBe("otelcol-contrib");
        expect(await configurationRow(configuration.id)).toMatchObject({ collector_distribution: "otelcol-contrib" });
        expect(await versionOf(configuration.id)).toMatchObject({
          collector_distribution: "otelcol-contrib",
          collector_version: contribDefault.version,
        });
      });

      it("refuses a distribution the catalog doesn't have: 400 collector_distribution_unknown, writing and auditing nothing", async () => {
        const { organization, access } = await personalUser();
        const before = await snapshot();

        expectRefusal(
          await create(access, organization.id, { name: "Gateway", collectorDistribution: "clickstack" }),
          400,
          ...DISTRIBUTION_UNKNOWN,
        );
        expect(await snapshot()).toEqual(before);
      });

      it("refuses a distribution that isn't in the catalog's format: 400 invalid_request", async () => {
        const { organization, access } = await personalUser();
        expectInvalid(await create(access, organization.id, { name: "Gateway", collectorDistribution: "OpenTelemetry Contrib" }));
        expect(await configurationRows()).toEqual([]);
      });
    });

    describe("saving a version's collector version", () => {
      it("stores a version the distribution offers as an ordinary save: 200 with it, the version's updatedAt moved, the configuration touched, and the save audited", async () => {
        const { organization, access } = await personalUser();
        const configuration = await created(access, organization.id, "Gateway");
        const version = await versionOf(configuration.id);
        tick();

        const response = await save(access, organization.id, configuration.id, version.id, saveBody(version.yaml_content, { collectorVersion: otherVersion }));

        expect(response.statusCode).toBe(200);
        expect(response.json<{ version: VersionBody }>().version).toMatchObject({
          collectorVersion: otherVersion,
          collectorVersionDeprecated: false,
          collectorVersionDeprecatedNote: null,
          updatedAt: clock.toISOString(),
        });
        expect(await versionOf(configuration.id)).toMatchObject({ collector_version: otherVersion, updated_at: clock });
        expect(await configurationRow(configuration.id)).toMatchObject({ updated_at: clock });
        expect((await configurationAudits()).at(-1)).toMatchObject({
          action: "configuration.version_saved",
          metadata: { versionId: version.id, versionNumber: 1 },
        });
        const body = (await read(access, organization.id, configuration.id)).json<WithVersionBody>();
        expect(body.version.collectorVersion).toBe(otherVersion);
        expect(body.versions[0]!.collectorVersion).toBe(otherVersion);
      });

      it("keeps the stored collector version when the save leaves it out", async () => {
        const { organization, access } = await personalUser();
        const configuration = await created(access, organization.id, "Gateway");
        const version = await versionOf(configuration.id);
        expect(
          (await save(access, organization.id, configuration.id, version.id, saveBody("", { collectorVersion: otherVersion }))).statusCode,
        ).toBe(200);
        tick();

        const response = await save(access, organization.id, configuration.id, version.id, saveBody("receivers: {}\n"));

        expect(response.statusCode).toBe(200);
        expect(response.json<{ version: VersionBody }>().version.collectorVersion).toBe(otherVersion);
        expect(await versionOf(configuration.id)).toMatchObject({
          yaml_content: "receivers: {}\n",
          collector_version: otherVersion,
        });
      });

      it("refuses a version the catalog doesn't have: 400 collector_version_unknown, writing, touching and auditing nothing", async () => {
        const { organization, access } = await personalUser();
        const configuration = await created(access, organization.id, "Gateway");
        const version = await versionOf(configuration.id);
        tick();
        const before = await snapshot();

        expectRefusal(
          await save(access, organization.id, configuration.id, version.id, saveBody("changed", { collectorVersion: "9.9.9" })),
          400,
          ...VERSION_UNKNOWN,
        );
        expect(await snapshot()).toEqual(before);
      });

      it("refuses a version that isn't in the catalog's format: 400 invalid_request", async () => {
        const { organization, access } = await personalUser();
        const configuration = await created(access, organization.id, "Gateway");
        const version = await versionOf(configuration.id);
        const before = await snapshot();
        expectInvalid(await save(access, organization.id, configuration.id, version.id, saveBody("", { collectorVersion: "latest" })));
        expect(await snapshot()).toEqual(before);
      });

      it.each([
        ["a version the distribution offers", () => otherVersion],
        ["one the catalogue doesn't have", () => "9.9.9"],
        ["the stored one", () => pin.version],
      ])("refuses a published version's save naming %s: 409 configuration_version_published, before the pin is checked, writing nothing", async (_label, collectorVersion) => {
        const { organization, access } = await personalUser();
        const configuration = await created(access, organization.id, "Gateway");
        const version = await versionOf(configuration.id);
        await publish(configuration.id);
        const before = await snapshot();

        expectRefusal(
          await save(access, organization.id, configuration.id, version.id, saveBody(version.yaml_content, { collectorVersion: collectorVersion() })),
          409,
          "configuration_version_published",
          MESSAGES.versionPublished,
        );
        expect(await snapshot()).toEqual(before);
      });
    });

    describe("creating a version", () => {
      it("from a published version, as the banner's \"Create a new version from it\" does: the new version has its pin", async () => {
        const { organization, access, configuration, first } = await withTwoVersions();
        await ownerDb.updateTable("configuration_versions").set({ collector_version: otherVersion }).where("id", "=", first.id).execute();
        await publish(configuration.id, 1);

        const response = await newVersion(access, organization.id, configuration.id, {
          sourceVersionId: first.id,
          yamlContent: first.yaml_content,
          ...EMPTY_GRAPH,
        });

        expect(response.statusCode).toBe(201);
        expect(response.json<{ version: VersionBody }>().version).toMatchObject({ versionNumber: 3, collectorVersion: otherVersion });
        expect(await versionNumbered(configuration.id, 3)).toMatchObject({
          collector_distribution: pin.distribution,
          collector_version: otherVersion,
        });
      });

      it("takes a collector version the distribution offers instead of the source's, the source untouched", async () => {
        const { organization, access, configuration, first } = await withTwoVersions();
        const before = await versionOf(configuration.id);

        const response = await newVersion(access, organization.id, configuration.id, {
          sourceVersionId: first.id,
          yamlContent: "",
          ...EMPTY_GRAPH,
          collectorVersion: otherVersion,
        });

        expect(response.statusCode).toBe(201);
        expect(response.json<{ version: VersionBody }>().version.collectorVersion).toBe(otherVersion);
        expect(await versionNumbered(configuration.id, 3)).toMatchObject({ collector_version: otherVersion });
        expect(await versionOf(configuration.id)).toEqual(before);
      });

      it("accepts the source's own collector version given again", async () => {
        const { organization, access, configuration, first } = await withTwoVersions();
        const response = await newVersion(access, organization.id, configuration.id, {
          sourceVersionId: first.id,
          yamlContent: "",
          ...EMPTY_GRAPH,
          collectorVersion: first.collector_version,
        });
        expect(response.statusCode).toBe(201);
        expect(await versionNumbered(configuration.id, 3)).toMatchObject({ collector_version: first.collector_version });
      });

      it("refuses a collector version the catalog doesn't have: 400 collector_version_unknown, creating, touching and auditing nothing", async () => {
        const { organization, access, configuration, first } = await withTwoVersions();
        const before = await snapshot();

        expectRefusal(
          await newVersion(access, organization.id, configuration.id, {
            sourceVersionId: first.id,
            yamlContent: "",
            ...EMPTY_GRAPH,
            collectorVersion: "9.9.9",
          }),
          400,
          ...VERSION_UNKNOWN,
        );
        expect(await snapshot()).toEqual(before);
      });

      it("refuses a distribution in the body (400 invalid_request): the server stamps the configuration's", async () => {
        const { organization, access, configuration, first } = await withTwoVersions();
        const before = await snapshot();
        expectInvalid(
          await newVersion(access, organization.id, configuration.id, {
            sourceVersionId: first.id,
            yamlContent: "",
            ...EMPTY_GRAPH,
            collectorDistribution: pin.distribution,
          }),
        );
        expect(await snapshot()).toEqual(before);
      });
    });
  });

  describe("under concurrency", () => {
    /**
     * Resolves once `count` backends other than this test's own wait on a
     * lock, or once `isSettled()` holds: the requests have reached the
     * lock the held transaction blocks, or didn't block at all (which the
     * assertions then catch). Throws after five seconds.
     */
    const waitForLockWaits = async (count: number, isSettled: () => boolean = () => false): Promise<void> => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        if (isSettled()) return;
        const { rows } = await sql<{ waiting: number }>`
          select count(*)::int as waiting
          from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
        `.execute(ownerDb);
        if ((rows[0]?.waiting ?? 0) >= count) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} backends to wait on a lock`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    /** Starts a request, and tracks whether it has finished. */
    const started = (request: Promise<LightMyRequestResponse>) => {
      const tracked = { isSettled: false, response: request };
      const settle = () => {
        tracked.isSettled = true;
      };
      request.then(settle, settle);
      return tracked;
    };

    /** Runs `work` while a separate connection, as the tables' owner, holds a transaction open; always ends it. */
    const withLocker = async (work: (locker: PoolClient, release: () => Promise<void>) => Promise<void>) => {
      const locker = await pool.connect();
      let isInTransaction = false;
      try {
        await locker.query("begin");
        isInTransaction = true;
        await work(locker, async () => {
          await locker.query("rollback");
          isInTransaction = false;
        });
      } finally {
        if (isInTransaction) await locker.query("rollback");
        locker.release();
      }
    };

    /**
     * Holds `lockSql`'s row from a side connection, starts `first` and waits
     * until it is blocked, then `second` and waits again, runs `whileHeld`,
     * then releases: the two go on in that order through the lock both queue
     * on.
     */
    const inOrder = async (
      lockSql: string,
      lockParameter: string,
      first: () => Promise<LightMyRequestResponse>,
      second: () => Promise<LightMyRequestResponse>,
      whileHeld: () => Promise<void> = async () => undefined,
    ): Promise<[LightMyRequestResponse, LightMyRequestResponse]> => {
      let responses: [LightMyRequestResponse, LightMyRequestResponse] | undefined;
      await withLocker(async (locker, release) => {
        await locker.query(lockSql, [lockParameter]);
        const a = started(first());
        await waitForLockWaits(1, () => a.isSettled);
        const b = started(second());
        await waitForLockWaits(2, () => b.isSettled);
        // Both queued on the held row: neither answered before it was released.
        expect([a.isSettled, b.isSettled]).toEqual([false, false]);
        await whileHeld();
        await release();
        responses = [await a.response, await b.response];
      });
      return responses!;
    };

    const HOLD_ORGANIZATION = "select id from organizations where id = $1 for update";
    const HOLD_CONFIGURATION = "select id from configurations where id = $1 for update";

    const removeMember = (access: string, organizationId: string, userId: string) =>
      server.inject({
        method: "DELETE",
        url: `/api/v1/organizations/${organizationId}/members/${userId}`,
        headers: csrfHeaders,
        cookies: { telflo_access: access },
      });

    const deleteOrganization = (access: string, organizationId: string) =>
      server.inject({
        method: "DELETE",
        url: `/api/v1/organizations/${organizationId}`,
        headers: csrfHeaders,
        cookies: { telflo_access: access },
      });

    describe("a rename and a delete of one configuration, with its row held", () => {
      // B is an admin of A's published configuration, so B may delete it.
      const both = async () => {
        const a = await memberActiveInGroup("admin");
        const b = await memberActiveInGroup("admin", a.group.id);
        const configuration = await created(a.access, a.group.id, "Contested");
        await publish(configuration.id);
        tick();
        return { a, b, group: a.group, configuration };
      };

      it("the rename first: it commits, and the delete then deletes the renamed configuration", async () => {
        const { a, b, group, configuration } = await both();

        const [renamed, deleted] = await inOrder(
          HOLD_CONFIGURATION,
          configuration.id,
          () => change(a.access, group.id, configuration.id, { name: "Renamed" }),
          () => remove(b.access, group.id, configuration.id),
        );

        expect(renamed.statusCode).toBe(200);
        expect(deleted.statusCode).toBe(204);
        expect(await configurationRow(configuration.id)).toMatchObject({ name: "Renamed", deleted_at: clock });
        expect((await configurationAudits()).map((row) => [row.action, row.metadata])).toEqual([
          ["configuration.created", { name: "Contested" }],
          ["configuration.updated", { from: { name: "Contested" }, to: { name: "Renamed" } }],
          ["configuration.deleted", { name: "Renamed" }],
        ]);
      });

      it("the delete first: it commits, and the rename is 404 configuration_not_found", async () => {
        const { a, b, group, configuration } = await both();

        const [deleted, renamed] = await inOrder(
          HOLD_CONFIGURATION,
          configuration.id,
          () => remove(b.access, group.id, configuration.id),
          () => change(a.access, group.id, configuration.id, { name: "Renamed" }),
        );

        expect(deleted.statusCode).toBe(204);
        expectRefusal(renamed, 404, "configuration_not_found", MESSAGES.configurationNotFound);
        expect(await configurationRow(configuration.id)).toMatchObject({ name: "Contested", deleted_at: clock });
        expect((await configurationAudits()).map((row) => row.action)).toEqual([
          "configuration.created",
          "configuration.deleted",
        ]);
      });
    });

    describe("a save and a delete of one configuration, with its row held", () => {
      // B is an admin of A's published configuration, so B may delete it; A
      // saves its draft version 2, since the published version 1 can't be
      // changed.
      const both = async () => {
        const a = await memberActiveInGroup("admin");
        const b = await memberActiveInGroup("admin", a.group.id);
        const configuration = await created(a.access, a.group.id, "Contested");
        await publish(configuration.id);
        // Stamped with the frozen clock, not the fixture's real time: a save
        // writes a millisecond past the version's updated_at when the clock
        // hasn't passed it, so a real stamp later than the clock would move
        // the save's off the clock.
        await addConfigurationVersion(ownerDb, {
          configurationId: configuration.id,
          organizationId: a.group.id,
          version_number: 2,
          created_at: clock,
          updated_at: clock,
        });
        const version = await versionNumbered(configuration.id, 2);
        tick();
        return { a, b, group: a.group, configuration, version };
      };

      /**
       * Fails with 55P03 while another transaction holds the version's row:
       * the save must wait for the configuration's lock before it writes the
       * version, so while that lock is held the version is untouched.
       */
      const expectVersionUnlocked = (versionId: string) => async () => {
        await expect(
          ownerDb
            .transaction()
            .execute((transaction) =>
              sql`select 1 from configuration_versions where id = ${versionId} for update nowait`.execute(transaction),
            ),
        ).resolves.toBeDefined();
      };

      it("the save first: it commits, and the delete then deletes the configuration", async () => {
        const { a, b, group, configuration, version } = await both();

        const [saved, deleted] = await inOrder(
          HOLD_CONFIGURATION,
          configuration.id,
          () =>
            save(a.access, group.id, configuration.id, version.id, { yamlContent: "saved first\n", ...EMPTY_GRAPH }),
          () => remove(b.access, group.id, configuration.id),
          expectVersionUnlocked(version.id),
        );

        expect(saved.statusCode).toBe(200);
        expect(deleted.statusCode).toBe(204);
        expect(await versionNumbered(configuration.id, 2)).toMatchObject({
          yaml_content: "saved first\n",
          updated_at: clock,
        });
        expect(await configurationRow(configuration.id)).toMatchObject({ deleted_at: clock });
        expect((await configurationAudits()).map((row) => row.action)).toEqual([
          "configuration.created",
          "configuration.version_saved",
          "configuration.deleted",
        ]);
      });

      it("the delete first: it commits, and the save is 404 configuration_not_found and writes nothing", async () => {
        const { a, b, group, configuration, version } = await both();

        const [deleted, saved] = await inOrder(
          HOLD_CONFIGURATION,
          configuration.id,
          () => remove(b.access, group.id, configuration.id),
          () =>
            save(a.access, group.id, configuration.id, version.id, { yamlContent: "saved too late\n", ...EMPTY_GRAPH }),
          expectVersionUnlocked(version.id),
        );

        expect(deleted.statusCode).toBe(204);
        expectRefusal(saved, 404, "configuration_not_found", MESSAGES.configurationNotFound);
        expect(await versionNumbered(configuration.id, 2)).toEqual(version);
        expect(await configurationRow(configuration.id)).toMatchObject({ deleted_at: clock, updated_at: clock });
        expect((await configurationAudits()).map((row) => row.action)).toEqual([
          "configuration.created",
          "configuration.deleted",
        ]);
      });
    });

    describe("two creates of one configuration, with its row held", () => {
      it("the second waits for the first, and takes the next number", async () => {
        const a = await memberActiveInGroup("admin");
        const b = await memberActiveInGroup("contributor", a.group.id);
        const configuration = await created(a.access, a.group.id, "Contested");
        // Published, so B sees it.
        await publish(configuration.id);
        const first = await versionOf(configuration.id);
        tick();

        const [one, two] = await inOrder(
          HOLD_CONFIGURATION,
          configuration.id,
          () =>
            newVersion(a.access, a.group.id, configuration.id, {
              sourceVersionId: first.id,
              label: "A's",
              yamlContent: "a\n",
              ...EMPTY_GRAPH,
            }),
          () =>
            newVersion(b.access, a.group.id, configuration.id, {
              sourceVersionId: first.id,
              label: "B's",
              yamlContent: "b\n",
              ...EMPTY_GRAPH,
            }),
        );

        expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
        expect(one.json<{ version: VersionBody }>().version).toMatchObject({ versionNumber: 2, label: "A's" });
        expect(two.json<{ version: VersionBody }>().version).toMatchObject({ versionNumber: 3, label: "B's" });
        expect(
          (await versionRows())
            .map((row) => [row.version_number, row.label, row.yaml_content])
            .sort((x, y) => Number(x[0]) - Number(y[0])),
        ).toEqual([
          [1, null, ""],
          [2, "A's", "a\n"],
          [3, "B's", "b\n"],
        ]);
        expect((await configurationAudits()).map((row) => [row.action, row.metadata])).toEqual([
          ["configuration.created", { name: "Contested" }],
          [
            "configuration.version_created",
            {
              versionId: one.json<{ version: VersionBody }>().version.id,
              versionNumber: 2,
              sourceVersionId: first.id,
              copiedSuites: 0,
              copiedDefinitions: 0,
              copiedValidationPipelines: 0,
              copiedValidationRules: 0,
            },
          ],
          [
            "configuration.version_created",
            {
              versionId: two.json<{ version: VersionBody }>().version.id,
              versionNumber: 3,
              sourceVersionId: first.id,
              copiedSuites: 0,
              copiedDefinitions: 0,
              copiedValidationPipelines: 0,
              copiedValidationRules: 0,
            },
          ],
        ]);
      });
    });

    describe("a version's create, rename or selection and a delete of its configuration, with its row held", () => {
      // B is an admin of A's published configuration, so B may delete it;
      // A's writes name its draft version 2, which may be renamed, unlike the
      // published version 1.
      const both = async () => {
        const a = await memberActiveInGroup("admin");
        const b = await memberActiveInGroup("admin", a.group.id);
        const configuration = await created(a.access, a.group.id, "Contested");
        await publish(configuration.id);
        await addConfigurationVersion(ownerDb, {
          configurationId: configuration.id,
          organizationId: a.group.id,
          version_number: 2,
        });
        const version = await versionNumbered(configuration.id, 2);
        tick();
        return { a, b, group: a.group, configuration, version };
      };

      type Both = Awaited<ReturnType<typeof both>>;

      /** Each write, by A, with what it leaves when it commits first, and its audit action if any. */
      const writes = [
        [
          "the create",
          ({ a, group, configuration, version }: Both) =>
            newVersion(a.access, group.id, configuration.id, {
              sourceVersionId: version.id,
              yamlContent: "created\n",
              ...EMPTY_GRAPH,
            }),
          201,
          async ({ configuration }: Both) => {
            expect((await versionNumbered(configuration.id, 3)).yaml_content).toBe("created\n");
          },
          "configuration.version_created",
        ],
        [
          "the rename",
          ({ a, group, configuration, version }: Both) =>
            renameVersion(a.access, group.id, configuration.id, version.id, { label: "Renamed" }),
          200,
          async ({ configuration }: Both) => {
            expect((await versionNumbered(configuration.id, 2)).label).toBe("Renamed");
          },
          "configuration.version_renamed",
        ],
        [
          "the selection",
          ({ a, group, configuration, version }: Both) =>
            selectVersion(a.access, group.id, configuration.id, { versionId: version.id }),
          204,
          async ({ a, version }: Both) => {
            expect((await selectionRows()).map((row) => [row.user_id, row.version_id])).toEqual([
              [a.account.user.id, version.id],
            ]);
          },
          undefined,
        ],
      ] as const;

      it.each(writes)(
        "%s first: it commits, and the delete then deletes the configuration",
        async (_name, write, status, written, action) => {
          const context = await both();
          const { b, group, configuration } = context;

          const [wrote, deleted] = await inOrder(
            HOLD_CONFIGURATION,
            configuration.id,
            () => write(context),
            () => remove(b.access, group.id, configuration.id),
          );

          expect(wrote.statusCode).toBe(status);
          expect(deleted.statusCode).toBe(204);
          await written(context);
          expect(await configurationRow(configuration.id)).toMatchObject({ deleted_at: clock });
          expect((await configurationAudits()).map((row) => row.action)).toEqual([
            "configuration.created",
            ...(action === undefined ? [] : [action]),
            "configuration.deleted",
          ]);
        },
      );

      it.each(writes)(
        "the delete first: it commits, and %s is 404 configuration_not_found, writing nothing",
        async (_name, write) => {
          const context = await both();
          const { b, group, configuration } = context;
          const before = await snapshot();

          const [deleted, wrote] = await inOrder(
            HOLD_CONFIGURATION,
            configuration.id,
            () => remove(b.access, group.id, configuration.id),
            () => write(context),
          );

          expect(deleted.statusCode).toBe(204);
          expectRefusal(wrote, 404, "configuration_not_found", MESSAGES.configurationNotFound);
          const after = await snapshot();
          // The delete's own changes alone: the row deleted, and its audit row.
          expect(after.versions).toEqual(before.versions);
          expect(after.selections).toEqual([]);
          expect(after.audits.map((row) => row.action)).toEqual(["configuration.created", "configuration.deleted"]);
          expect(await configurationRow(configuration.id)).toMatchObject({ deleted_at: clock, updated_at: clock });
        },
      );
    });

    describe("a save racing its author's removal, with the organization held", () => {
      const both = async () => {
        const admin = await memberActiveInGroup("admin");
        const member = await memberActiveInGroup("contributor", admin.group.id);
        const configuration = await created(admin.access, admin.group.id, "Shared");
        // Published, so the member sees it, and its draft version 2 is what
        // they save.
        await publish(configuration.id);
        await addConfigurationVersion(ownerDb, {
          configurationId: configuration.id,
          organizationId: admin.group.id,
          version_number: 2,
        });
        const version = await versionNumbered(configuration.id, 2);
        tick();
        return { admin, member, configuration, version };
      };

      it("the removal first: the save is 404 organization_not_found and writes nothing", async () => {
        const { admin, member, configuration, version } = await both();
        const before = await snapshot();

        const [removal, saved] = await inOrder(
          HOLD_ORGANIZATION,
          admin.group.id,
          () => removeMember(admin.access, admin.group.id, member.account.user.id),
          () =>
            save(member.access, admin.group.id, configuration.id, version.id, {
              yamlContent: "too late\n",
              ...EMPTY_GRAPH,
            }),
        );

        expect(removal.statusCode).toBe(204);
        expectRefusal(saved, 404, "organization_not_found", MESSAGES.organizationNotFound);
        expect(await snapshot()).toEqual(before);
      });

      it("the save first: it commits, and the removal then removes the member", async () => {
        const { admin, member, configuration, version } = await both();

        const [saved, removal] = await inOrder(
          HOLD_ORGANIZATION,
          admin.group.id,
          () =>
            save(member.access, admin.group.id, configuration.id, version.id, {
              yamlContent: "just in time\n",
              ...EMPTY_GRAPH,
            }),
          () => removeMember(admin.access, admin.group.id, member.account.user.id),
        );

        expect(saved.statusCode).toBe(200);
        expect(removal.statusCode).toBe(204);
        expect((await versionNumbered(configuration.id, 2)).yaml_content).toBe("just in time\n");
      });
    });

    describe("a create racing its creator's removal, with the organization held", () => {
      it("the removal first: the create is 404 organization_not_found and writes nothing", async () => {
        const admin = await memberActiveInGroup("admin");
        const member = await memberActiveInGroup("contributor", admin.group.id);
        const before = await snapshot();

        const [removal, creation] = await inOrder(
          HOLD_ORGANIZATION,
          admin.group.id,
          () => removeMember(admin.access, admin.group.id, member.account.user.id),
          () => create(member.access, admin.group.id, { name: "Too late" }),
        );

        expect(removal.statusCode).toBe(204);
        expectRefusal(creation, 404, "organization_not_found", MESSAGES.organizationNotFound);
        expect(await snapshot()).toEqual(before);
      });

      it("the create first: it commits, and the removal then removes the member", async () => {
        const admin = await memberActiveInGroup("admin");
        const member = await memberActiveInGroup("contributor", admin.group.id);

        const [creation, removal] = await inOrder(
          HOLD_ORGANIZATION,
          admin.group.id,
          () => create(member.access, admin.group.id, { name: "Just in time" }),
          () => removeMember(admin.access, admin.group.id, member.account.user.id),
        );

        expect(creation.statusCode).toBe(201);
        expect(removal.statusCode).toBe(204);
        // The member's draft, which the admin doesn't see: read as the owner.
        expect((await configurationRows()).map((row) => [row.name, row.created_by_user_id])).toEqual([
          ["Just in time", member.account.user.id],
        ]);
      });
    });

    describe("a create racing the organization's deletion, with the organization held", () => {
      it("the deletion first: the create is 404 organization_not_found and writes nothing", async () => {
        const admin = await memberActiveInGroup("admin");
        const member = await memberActiveInGroup("contributor", admin.group.id);
        const before = await snapshot();

        const [deletion, creation] = await inOrder(
          HOLD_ORGANIZATION,
          admin.group.id,
          () => deleteOrganization(admin.access, admin.group.id),
          () => create(member.access, admin.group.id, { name: "Too late" }),
        );

        expect(deletion.statusCode).toBe(204);
        expectRefusal(creation, 404, "organization_not_found", MESSAGES.organizationNotFound);
        expect(await snapshot()).toEqual(before);
        // Both keep their personal organizations: the deletion left their accounts.
        for (const account of [admin.account, member.account]) {
          expect(
            await ownerDb
              .selectFrom("users")
              .select("deleted_at")
              .where("id", "=", account.user.id)
              .executeTakeFirstOrThrow(),
          ).toEqual({ deleted_at: null });
        }
      });
    });
  });
});
