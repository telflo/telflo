import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, FLEETS_UNAVAILABLE_MESSAGE } from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  catalogueDefaults,
  createUserWithOrganization,
  truncateAll,
} from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { createOpampServerClient, OpampServerMisconfigurationError, sha256Hex, type OpampServerClient } from "../../opamp-server/client.js";
import type { FakeOpampServerFault } from "../../testing/fake-opamp-server.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import type * as PublishedVersionRepository from "../configurations/repositories/published-version-repository.js";
import { hashPassword } from "../identity/password.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

/** How many reverse lookups (one query per reply) the server has made: the repository's `describe`, counted. */
const reverseLookups = vi.hoisted(() => ({ count: 0 }));

vi.mock("../configurations/repositories/published-version-repository.js", async (importOriginal) => {
  const original = await importOriginal<typeof PublishedVersionRepository>();
  return {
    ...original,
    createPublishedVersionRepository: (...args: Parameters<typeof original.createPublishedVersionRepository>) => {
      const repository = original.createPublishedVersionRepository(...args);
      return {
        ...repository,
        describe: (publicationIds: readonly string[]) => {
          reverseLookups.count += 1;
          return repository.describe(publicationIds);
        },
      };
    },
  };
});

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

const MESSAGES = {
  organizationNotFound: "Organization not found",
  fleetNotFound: "Fleet not found",
  groupNotFound: "Collector group not found",
  collectorNotFound: "Collector not found",
  configurationNotFound: "Configuration not found",
  versionNotFound: "Version not found",
  notPublished: "This version isn't published: publish it before assigning or pinning it.",
  kubernetesOnServer: "Only a kubernetes-supervisor fleet's groups take Kubernetes settings.",
  dockerMountsOnKubernetes: "Only a server fleet's groups take Docker mounts.",
  kubernetesName: "A Kubernetes fleet's group is the Cluster (named cluster) or a gateway pool.",
  kubernetesRole: "The group's Kubernetes settings must name its role.",
  kubernetesSettings: "A Kubernetes fleet's group keeps its Kubernetes settings in its annotations.",
  nameFixed: "A Kubernetes group's name can't change: its Helm release is named after it.",
  terms: "Accept the current Terms of Service to continue.",
  rateLimited: "Too many attempts. Please wait and try again.",
  disagreed: "fleet management failed: the opamp-server doesn't hold a published version the platform resolved",
};

/** Ids that aren't canonical UUIDs, as a path segment carries them. */
const MALFORMED_PATH_IDS = ["not-a-uuid", "42", "0192F1A47B3C7D2E8F101A2B3C4D5E6F"];

type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface PublishedVersionBody {
  configurationId: string;
  configurationName: string;
  versionId: string;
  versionNumber: number;
  versionLabel: string | null;
  collectorDistribution: string;
  collectorVersion: string;
}

interface GroupBody {
  id: string;
  fleetId: string;
  name: string;
  isDefault: boolean;
  annotations: Record<string, unknown> | null;
  assignedPublishedVersionId: string | null;
  assignedVersion: PublishedVersionBody | null;
}

interface CollectorBody {
  id: string;
  name: string;
  groupId: string;
  pin:
    | { kind: "version"; versionId: string | null; publishedVersionId: string; version: PublishedVersionBody | null }
    | null;
  resolution: { from: "pinnedVersion" | "groupVersion"; publishedVersionId: string; sha256: string; version: PublishedVersionBody | null } | null;
  served: { kind: "version"; publishedVersionId: string | null; sha256: string; at: string | null; version: PublishedVersionBody | null } | null;
  effective: { status: string; error: string | null } | null;
  reported: { attributes: Record<string, string> | null };
  drift: string;
  liveness: string;
}

/** One call the server made to the opamp-server, through the wrapper. */
interface Call {
  operation: keyof OpampServerClient;
  args: unknown[];
}

/** A one-shot gate: `hold` waits until `release`, and `reached` resolves once something holds. */
function createGate() {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (open = resolve));
  return {
    reached,
    release: () => open(),
    hold: async () => {
      reach();
      await released;
    },
  };
}

/**
 * The collector groups', collectors' and a configuration's fleet usage routes,
 * against Postgres through the API as its own role, with the OpenAPI-checked
 * fake as the opamp-server. The server's client is the fake's, wrapped: every
 * call is recorded, and a test can put a hook in front of any method.
 */
describe("the collector group, collector and fleet usage routes", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  /** The server's log lines since the test began, at info and above. */
  let logLines: string[] = [];
  let runner: CollectingRunner;
  let calls: Call[] = [];
  let hooks: Partial<Record<keyof OpampServerClient, (...args: unknown[]) => Promise<unknown>>> = {};

  /** The wrapper the server calls: each method records the call, then runs the test's hook or the fake's client. */
  const serverClient = new Proxy({} as OpampServerClient, {
    get(_target, property) {
      const operation = property as keyof OpampServerClient;
      return (...args: unknown[]) => {
        calls.push({ operation, args });
        const target = (hooks[operation] ?? opamp.client[operation]) as (...given: unknown[]) => Promise<unknown>;
        return target(...args);
      };
    },
  });

  function build(rateLimits: RateLimits): FastifyInstance {
    const previousLevel = process.env.LOG_LEVEL;
    // Info, so each request's own log line is captured too.
    process.env.LOG_LEVEL = "info";
    try {
      return buildServer({
        opampServer: serverClient,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer: createInMemoryMailer(),
        now: () => clock,
        rateLimits,
        runAfterResponse: (task) => runner.run(task),
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
  }

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    server = build(TEST_RATE_LIMITS);
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
    clock = new Date(Math.floor(Date.now() / 1000) * 1000);
    logLines = [];
    runner = createCollectingRunner();
    calls = [];
    hooks = {};
    reverseLookups.count = 0;
  });

  const operations = () => calls.map((call) => call.operation);

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message?: string): void {
    expect({ status: response.statusCode, code: response.json<{ error: { code: string } }>().error.code }).toEqual({
      status: statusCode,
      code,
    });
    if (message !== undefined) expect(response.json<{ error: { message: string } }>().error.message).toBe(message);
  }

  /** The fields a 400's `details` name, by their instancePath. */
  function detailPaths(response: LightMyRequestResponse): string[] {
    return (response.json<{ error: { details?: { instancePath: string }[] } }>().error.details ?? []).map((detail) => detail.instancePath);
  }

  /** No log line holds any of `privates`. */
  function expectNotLogged(...privates: string[]): void {
    expect(logLines.length).toBeGreaterThan(0);
    for (const value of privates) expect(logLines.filter((line) => line.includes(value))).toEqual([]);
  }

  const logged = () => logLines.map((line) => JSON.parse(line) as Record<string, unknown>);

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
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

  const signedIn = async (on: FastifyInstance, email: string) => {
    const response = await on.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return cookieValue(response, "telflo_access");
  };

  const switchTo = async (on: FastifyInstance, access: string, organizationId: string) => {
    const response = await on.inject({
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

  interface Person {
    userId: string;
    email: string;
    access: string;
  }

  /** A signed-in user who is a `role` of a group organization (a new one unless given) and active in it. */
  const member = async (role: OrganizationRole, organizationId?: string, on: FastifyInstance = server) => {
    const account = await verifiedUser();
    const { organization } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const access = await switchTo(on, await signedIn(on, account.user.email), organization.id);
    return { organizationId: organization.id, person: { userId: account.user.id, email: account.user.email, access } };
  };

  /** A group organization with an admin and a contributor, both active in it. */
  const team = async (on: FastifyInstance = server) => {
    const { organizationId, person: admin } = await member("admin", undefined, on);
    const { person: contributor } = await member("contributor", organizationId, on);
    return { organizationId, admin, contributor };
  };

  const fleetsPath = (organizationId: string) => `/api/v1/organizations/${organizationId}/fleets`;
  const fleetPath = (organizationId: string, fleetId: string) => `${fleetsPath(organizationId)}/${fleetId}`;
  const usagePath = (organizationId: string, configurationId: string) =>
    `/api/v1/organizations/${organizationId}/configurations/${configurationId}/fleet-usage`;

  const send = (
    person: Pick<Person, "access"> | undefined,
    method: Method,
    url: string,
    payload?: Record<string, unknown>,
    on: FastifyInstance = server,
  ) =>
    on.inject({
      method,
      url,
      headers: csrfHeaders,
      ...(person === undefined ? {} : { cookies: { telflo_access: person.access } }),
      ...(payload === undefined ? {} : { payload }),
    });

  let labels = 0;

  /** A fleet created through the API (which registers the organization with the opamp-server): its id and Default group's. */
  const created = async (person: Person, organizationId: string, type = "server", on = server) => {
    const response = await send(
      person,
      "POST",
      fleetsPath(organizationId),
      { label: `fleet-${++labels}`, type, rotateExpiresAt: null },
      on,
    );
    expect(response.statusCode).toBe(201);
    const body = response.json<{ fleet: { id: string }; defaultGroup: { id: string } }>();
    return { fleetId: body.fleet.id, defaultGroupId: body.defaultGroup.id };
  };

  /** A group created through the API. */
  const groupIn = async (person: Person, organizationId: string, fleetId: string, fields: Record<string, unknown> = {}) => {
    const response = await send(person, "POST", `${fleetPath(organizationId, fleetId)}/groups`, { name: `group-${++labels}`, ...fields });
    expect(response.statusCode).toBe(201);
    return response.json<{ group: GroupBody }>().group;
  };

  /** Registers the organization with the opamp-server under its own name, as a fleet's create or a publish would. */
  const registered = async (organizationId: string) => {
    const { name } = await ownerDb.selectFrom("organizations").select("name").where("id", "=", organizationId).executeTakeFirstOrThrow();
    const result = await opamp.client.createOrganization({ id: organizationId, name });
    expect(["created", "unchanged"]).toContain(result.kind);
  };

  /** The opamp-server's published copy of a version, as a publish puts it. */
  const postPublication = async (
    organizationId: string,
    publicationId: string,
    configuration: { id: string; name: string },
    version: { id: string; number: number; label: string | null },
  ) => {
    await registered(organizationId);
    const yaml = `receivers: {}\n# ${randomUUID()}\n`;
    const result = await opamp.client.postPublication(organizationId, publicationId, {
      configuration,
      version,
      yaml,
      sha256: sha256Hex(yaml),
      publishedBy: null,
      publishedAt: clock.toISOString(),
      collector: await catalogueDefaults(ownerDb),
    });
    expect(result.kind).toBe("created");
  };

  interface Published extends PublishedVersionBody {
    publicationId: string;
  }

  /**
   * A version of a configuration `creatorUserId` made, published as a publish
   * leaves one: the platform's rows (as the owner: the API's role can't
   * insert a published version) and the opamp-server's published copy.
   */
  const publishedVersion = async (
    organizationId: string,
    creatorUserId: string,
    fields: { label?: string | null; versionNumber?: number; name?: string } = {},
  ): Promise<Published> => {
    const configuration = await addConfiguration(ownerDb, {
      organizationId,
      created_by_user_id: creatorUserId,
      name: fields.name ?? `payments-gateway-${randomUUID()}`,
    });
    const versionLabel = fields.label === undefined ? "TLS on" : fields.label;
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId,
      created_by_user_id: creatorUserId,
      version_number: fields.versionNumber ?? 3,
      label: versionLabel,
      yaml_content: "receivers: {}\n",
      publishedAt: new Date(),
      publishedByUserId: creatorUserId,
    });
    const publicationId = version.publication_id as string;
    await postPublication(
      organizationId,
      publicationId,
      { id: configuration.id, name: configuration.name },
      { id: version.id, number: version.version_number, label: versionLabel },
    );
    return {
      configurationId: configuration.id,
      configurationName: configuration.name,
      versionId: version.id,
      versionNumber: version.version_number,
      versionLabel,
      collectorDistribution: version.collector_distribution,
      collectorVersion: version.collector_version,
      publicationId,
    };
  };

  /** A draft configuration of `creatorUserId`'s, its version 1 never published: theirs alone to see. */
  const draftVersion = async (organizationId: string, creatorUserId: string) => {
    const configuration = await addConfiguration(ownerDb, { organizationId, created_by_user_id: creatorUserId });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId,
      created_by_user_id: creatorUserId,
      yaml_content: "receivers: {}\n",
    });
    return { configurationId: configuration.id, versionId: version.id };
  };

  /** A published configuration's draft version 2: visible to every member, not published. */
  const unpublishedVersionOf = async (organizationId: string, published: Published) => {
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: published.configurationId,
      organizationId,
      version_number: published.versionNumber + 1,
      yaml_content: "exporters: {}\n",
    });
    return version.id;
  };

  const softDelete = (configurationId: string) =>
    ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", configurationId).execute();

  const expectedVersion = (published: Published): PublishedVersionBody => ({
    configurationId: published.configurationId,
    configurationName: published.configurationName,
    versionId: published.versionId,
    versionNumber: published.versionNumber,
    versionLabel: published.versionLabel,
    collectorDistribution: published.collectorDistribution,
    collectorVersion: published.collectorVersion,
  });

  /**
   * The organization's audit rows of any action but a session's: a member switching to it, or signing in
   * there (a sign-in lands in the newest membership).
   */
  const auditActions = async (organizationId: string) =>
    (
      await ownerDb
        .selectFrom("audit_events")
        .select("action")
        .where("organization_id", "=", organizationId)
        .where("action", "not like", "session.%")
        .where("action", "<>", "user.signed_in")
        .orderBy("id")
        .execute()
    ).map((row) => row.action);

  const auditText = async (organizationId: string) =>
    JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().where("organization_id", "=", organizationId).execute());

  /**
   * A team with a server fleet holding a group, a collector in it with an
   * error, and a published version of the admin's configuration.
   */
  const aWorld = async (on: FastifyInstance = server) => {
    const { organizationId, admin, contributor } = await team(on);
    const { fleetId, defaultGroupId } = await created(admin, organizationId, "server", on);
    const groupResponse = await send(admin, "POST", `${fleetPath(organizationId, fleetId)}/groups`, { name: `group-${++labels}` }, on);
    expect(groupResponse.statusCode).toBe(201);
    const group = groupResponse.json<{ group: GroupBody }>().group;
    const collector = opamp.fake.enrollCollector(organizationId, fleetId, { groupId: group.id });
    opamp.fake.recordCollectorError(organizationId, collector.id, { message: "bad configuration" });
    const published = await publishedVersion(organizationId, admin.userId);
    calls = [];
    logLines = [];
    return { organizationId, admin, contributor, fleetId, defaultGroupId, group, collector, published };
  };

  type World = Awaited<ReturnType<typeof aWorld>>;

  /** Every group and collector route under the fleet, naming the world's ids, with a valid body, and the operation it calls. */
  function taskRoutes(organizationId: string, fleetId: string, ids: { group: string; collector: string }) {
    const fleet = fleetPath(organizationId, fleetId);
    return [
      ["GET", `${fleet}/groups`, undefined, "listCollectorGroups"],
      ["POST", `${fleet}/groups`, { name: "edge" }, "createCollectorGroup"],
      ["GET", `${fleet}/groups/${ids.group}`, undefined, "getCollectorGroup"],
      ["PATCH", `${fleet}/groups/${ids.group}`, { name: "renamed" }, "updateCollectorGroup"],
      ["DELETE", `${fleet}/groups/${ids.group}`, undefined, "deleteCollectorGroup"],
      ["GET", `${fleet}/collectors`, undefined, "listCollectorInstances"],
      ["POST", `${fleet}/collectors/pin`, { collectorIds: [ids.collector], pin: null }, "pinCollectorInstances"],
      ["GET", `${fleet}/collectors/${ids.collector}`, undefined, "getCollectorInstance"],
      ["PATCH", `${fleet}/collectors/${ids.collector}`, { name: "renamed" }, "updateCollectorInstance"],
      ["DELETE", `${fleet}/collectors/${ids.collector}`, undefined, "deleteCollectorInstance"],
      ["GET", `${fleet}/collectors/${ids.collector}/errors`, undefined, "listCollectorInstanceErrors"],
    ] as const satisfies readonly (readonly [Method, string, Record<string, unknown> | undefined, keyof OpampServerClient])[];
  }

  /** Every group and collector route of the world, the fleet usage included. */
  function worldRoutes(world: Pick<World, "organizationId" | "fleetId" | "group" | "collector" | "published">) {
    return [
      ...taskRoutes(world.organizationId, world.fleetId, { group: world.group.id, collector: world.collector.id }),
      ["GET", usagePath(world.organizationId, world.published.configurationId), undefined, "getConfigurationUsage"],
    ] as const;
  }

  // -------------------------------------------------------------------------

  // The opamp-server (0.2.4) names a collector's state `sync`; the
  // platform's contract keeps `drift`, the same values.
  it("answers the opamp-server's sync as each collector's drift, every value, in the list and a read", async () => {
    const world = await aWorld();
    const collectors = `${fleetPath(world.organizationId, world.fleetId)}/collectors`;
    // The fake's own answer for an unassigned collector, through the platform.
    const plain = await send(world.admin, "GET", `${collectors}/${world.collector.id}`);
    expect(plain.json<{ collector: CollectorBody }>().collector.drift).toBe("unassigned");

    for (const sync of ["inSync", "pending", "failed", "drifted", "unassigned"] as const) {
      hooks.listCollectorInstances = async (...args: unknown[]) => {
        const result = await opamp.client.listCollectorInstances(...(args as Parameters<OpampServerClient["listCollectorInstances"]>));
        return result.kind === "page"
          ? { ...result, page: { ...result.page, collectors: result.page.collectors.map((collector) => ({ ...collector, sync })) } }
          : result;
      };
      hooks.getCollectorInstance = async (...args: unknown[]) => {
        const result = await opamp.client.getCollectorInstance(...(args as Parameters<OpampServerClient["getCollectorInstance"]>));
        return result.kind === "found" ? { ...result, collector: { ...result.collector, sync } } : result;
      };

      const list = await send(world.admin, "GET", collectors);
      expect(list.statusCode).toBe(200);
      expect(list.json<{ collectors: CollectorBody[] }>().collectors.map((collector) => collector.drift)).toEqual([sync]);
      const read = await send(world.admin, "GET", `${collectors}/${world.collector.id}`);
      expect(read.statusCode).toBe(200);
      const body = read.json<{ collector: CollectorBody & { sync?: unknown } }>().collector;
      expect(body.drift).toBe(sync);
      expect(body).not.toHaveProperty("sync");
    }
  });

  describe.each(["admin", "contributor"] as const)("for a %s (every member)", (role) => {
    it("creates a group assigned a published version (the platform's names beside it), lists, reads, renames, unassigns and deletes it, auditing nothing", async () => {
      const world = await aWorld();
      const person = world[role];
      const groups = `${fleetPath(world.organizationId, world.fleetId)}/groups`;

      const create = await send(person, "POST", groups, { name: "gateways", assignedVersionId: world.published.versionId.toUpperCase() });
      expect(create.statusCode).toBe(201);
      const group = create.json<{ group: GroupBody }>().group;
      expect(group).toMatchObject({
        name: "gateways",
        isDefault: false,
        assignedPublishedVersionId: world.published.publicationId,
        assignedVersion: expectedVersion(world.published),
      });
      // The opamp-server is sent the published copy's id, never the version's (the fleet's type read first).
      expect(operations()).toEqual(["getFleet", "createCollectorGroup"]);
      expect(calls[1]?.args[2]).toEqual({ name: "gateways", assignedPublicationId: world.published.publicationId });

      const list = await send(person, "GET", groups);
      expect(list.statusCode).toBe(200);
      const listed = list.json<{ groups: GroupBody[] }>().groups;
      expect(listed.map((g) => [g.name, g.assignedVersion])).toEqual([
        ["Default", null],
        ["gateways", expectedVersion(world.published)],
        [world.group.name, null],
      ]);

      const read = await send(person, "GET", `${groups}/${group.id}`);
      expect(read.json<{ group: GroupBody }>().group).toEqual(group);

      const renamed = await send(person, "PATCH", `${groups}/${group.id}`, { name: "edge-gateways" });
      expect(renamed.json<{ group: GroupBody }>().group).toMatchObject({ name: "edge-gateways", assignedVersion: expectedVersion(world.published) });
      const unassigned = await send(person, "PATCH", `${groups}/${group.id}`, { assignedVersionId: null });
      expect(unassigned.json<{ group: GroupBody }>().group).toMatchObject({ assignedPublishedVersionId: null, assignedVersion: null });
      expect(calls.at(-1)?.args[3]).toEqual({ assignedPublicationId: null });

      // A group's delete deletes its collectors.
      const removed = await send(person, "DELETE", `${groups}/${world.group.id}`);
      expect(removed.statusCode).toBe(204);
      const gone = await send(person, "GET", `${fleetPath(world.organizationId, world.fleetId)}/collectors/${world.collector.id}`);
      expectRefusal(gone, 404, "collector_not_found", MESSAGES.collectorNotFound);
      expectRefusal(await send(person, "GET", `${groups}/${world.group.id}`), 404, "collector_group_not_found", MESSAGES.groupNotFound);

      expect(await auditActions(world.organizationId)).toEqual(["fleet.created"]);
    });

    it("lists, searches, reads, renames, moves, pins (one and in bulk), unpins and deletes collectors, auditing nothing; the reads and the update no-store", async () => {
      const world = await aWorld();
      const person = world[role];
      const collectors = `${fleetPath(world.organizationId, world.fleetId)}/collectors`;
      const other = opamp.fake.enrollCollector(world.organizationId, world.fleetId, { name: "edge-02", reported: { ip: "10.0.0.2" } });

      const list = await send(person, "GET", `${collectors}?sort=name&order=asc`);
      expect(list.statusCode).toBe(200);
      expect(list.json<{ collectors: CollectorBody[] }>().collectors.map((c) => c.name)).toEqual([world.collector.name, "edge-02"].sort());
      // Reported attributes and error text: no cache keeps a copy.
      expect(list.headers["cache-control"]).toBe("no-store");
      const searched = await send(person, "GET", `${collectors}?q=10.0.0&groupId=${world.defaultGroupId}`);
      expect(searched.json<{ collectors: CollectorBody[]; nextCursor: null }>()).toMatchObject({ collectors: [{ id: other.id }], nextCursor: null });
      expect(calls.at(-1)?.args[2]).toEqual({ limit: 50, q: "10.0.0", groupId: world.defaultGroupId });

      const read = await send(person, "GET", `${collectors}/${world.collector.id}`);
      expect(read.json<{ collector: CollectorBody }>().collector).toMatchObject({ id: world.collector.id, groupId: world.group.id, pin: null, resolution: null });
      expect(read.headers["cache-control"]).toBe("no-store");

      const renamed = await send(person, "PATCH", `${collectors}/${world.collector.id}`, { name: "edge-01", groupId: world.defaultGroupId });
      expect(renamed.json<{ collector: CollectorBody }>().collector).toMatchObject({ name: "edge-01", groupId: world.defaultGroupId });
      expect(renamed.headers["cache-control"]).toBe("no-store");

      const pinned = await send(person, "PATCH", `${collectors}/${world.collector.id}`, {
        pin: { kind: "version", versionId: world.published.versionId },
      });
      expect(pinned.statusCode).toBe(200);
      expect(pinned.json<{ collector: CollectorBody }>().collector).toMatchObject({
        pin: {
          kind: "version",
          versionId: world.published.versionId,
          publishedVersionId: world.published.publicationId,
          version: expectedVersion(world.published),
        },
        resolution: { from: "pinnedVersion", publishedVersionId: world.published.publicationId, version: expectedVersion(world.published) },
      });
      // A reply's pin is re-sendable: its kind and versionId are a pin's request.
      const { kind, versionId } = pinned.json<{ collector: { pin: { kind: string; versionId: string } } }>().collector.pin;
      const resent = await send(person, "PATCH", `${collectors}/${world.collector.id}`, { pin: { kind, versionId } });
      expect(resent.statusCode).toBe(200);
      expect(resent.json<{ collector: CollectorBody }>().collector.pin).toEqual(pinned.json<{ collector: CollectorBody }>().collector.pin);
      expect(calls.at(-1)?.args[3]).toEqual({ pin: { kind: "publication", id: world.published.publicationId } });

      const bulk = await send(person, "POST", `${collectors}/pin`, {
        collectorIds: [other.id, world.collector.id, randomUUID()].map((id) => id.toUpperCase()),
        pin: { kind: "version", versionId: world.published.versionId },
      });
      expect(bulk.statusCode).toBe(200);
      const answered = bulk.json<{ updated: string[]; notFound: string[] }>();
      expect(answered.updated).toEqual([other.id, world.collector.id].sort());
      expect(answered.notFound).toHaveLength(1);
      // The bulk pin's answer holds ids only: cacheable, as before.
      expect(bulk.headers["cache-control"]).toBeUndefined();
      const bulkPinned = await send(person, "GET", `${collectors}/${other.id}`);
      expect(bulkPinned.json<{ collector: CollectorBody }>().collector).toMatchObject({
        pin: { kind: "version", versionId: world.published.versionId, publishedVersionId: world.published.publicationId },
        resolution: { from: "pinnedVersion", publishedVersionId: world.published.publicationId },
      });

      const unpinned = await send(person, "POST", `${collectors}/pin`, { collectorIds: [other.id], pin: null });
      expect(unpinned.json()).toEqual({ updated: [other.id], notFound: [] });

      const errors = await send(person, "GET", `${collectors}/${world.collector.id}/errors`);
      expect(errors.json()).toEqual({
        errors: [{ id: expect.any(String), reportedAt: expect.any(String), configSha256: null, message: "bad configuration" }],
        nextCursor: null,
      });
      expect(errors.headers["cache-control"]).toBe("no-store");

      expect((await send(person, "DELETE", `${collectors}/${other.id}`)).statusCode).toBe(204);
      const gone = await send(person, "GET", `${collectors}/${other.id}`);
      expectRefusal(gone, 404, "collector_not_found", MESSAGES.collectorNotFound);
      // A refusal carries no header.
      expect(gone.headers["cache-control"]).toBeUndefined();
      expectRefusal(await send(person, "GET", `${collectors}/${other.id}/errors`), 404, "collector_not_found");

      expect(await auditActions(world.organizationId)).toEqual(["fleet.created"]);
    });

    it("answers a configuration's fleet usage: each published version's groups and pinned collectors, the platform's names beside it", async () => {
      const world = await aWorld();
      const person = world[role];
      const assigned = await groupIn(world.admin, world.organizationId, world.fleetId, { assignedVersionId: world.published.versionId });
      const pinnedCollector = opamp.fake.enrollCollector(world.organizationId, world.fleetId);
      await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/collectors/pin`, {
        collectorIds: [pinnedCollector.id],
        pin: { kind: "version", versionId: world.published.versionId },
      });
      calls = [];

      const usage = await send(person, "GET", usagePath(world.organizationId, world.published.configurationId));
      expect(usage.statusCode).toBe(200);
      expect(usage.json()).toEqual({
        usage: {
          configurationId: world.published.configurationId,
          inUse: true,
          publishedVersions: [
            {
              publishedVersionId: world.published.publicationId,
              publishedAt: expect.any(String),
              groups: [{ fleetId: world.fleetId, groupId: assigned.id }],
              pinnedCollectors: 1,
              version: expectedVersion(world.published),
              recorded: { number: world.published.versionNumber, label: world.published.versionLabel },
            },
          ],
        },
      });
      expect(operations()).toEqual(["getConfigurationUsage"]);
    });
  });

  // -------------------------------------------------------------------------

  describe("published versions on the wire", () => {
    /** Each write naming a configuration version, as its route takes it. */
    const versionWrites = (world: World, versionId: string) => {
      const fleet = fleetPath(world.organizationId, world.fleetId);
      return [
        ["a group's create", "POST", `${fleet}/groups`, { name: "assigned", assignedVersionId: versionId }],
        ["a group's update", "PATCH", `${fleet}/groups/${world.group.id}`, { assignedVersionId: versionId }],
        ["a collector's pin", "PATCH", `${fleet}/collectors/${world.collector.id}`, { pin: { kind: "version", versionId } }],
        ["a bulk pin", "POST", `${fleet}/collectors/pin`, { collectorIds: [world.collector.id], pin: { kind: "version", versionId } }],
      ] as const;
    };

    it.each([
      ["another organization's version", "configuration_version_not_found"],
      ["another member's draft", "configuration_version_not_found"],
      ["a deleted configuration's version", "configuration_version_not_found"],
      ["an unknown version", "configuration_version_not_found"],
      ["the person's own draft, never published", "configuration_version_not_published"],
      ["a published configuration's unpublished version", "configuration_version_not_published"],
    ])("refuses %s before any call (%s), changing nothing", async (label, code) => {
      const world = await aWorld();
      let versionId: string;
      if (label === "another organization's version") {
        const theirs = await team();
        versionId = (await publishedVersion(theirs.organizationId, theirs.admin.userId)).versionId;
      } else if (label === "another member's draft") {
        versionId = (await draftVersion(world.organizationId, world.contributor.userId)).versionId;
      } else if (label === "a deleted configuration's version") {
        const deleted = await publishedVersion(world.organizationId, world.admin.userId);
        await softDelete(deleted.configurationId);
        versionId = deleted.versionId;
      } else if (label === "an unknown version") {
        versionId = randomUUID();
      } else if (label === "the person's own draft, never published") {
        versionId = (await draftVersion(world.organizationId, world.admin.userId)).versionId;
      } else {
        versionId = await unpublishedVersionOf(world.organizationId, world.published);
      }
      const before = opamp.fake.snapshotOf(world.organizationId);
      calls = [];

      for (const [write, method, url, payload] of versionWrites(world, versionId)) {
        const response = await send(world.admin, method, url, payload);
        if (code === "configuration_version_not_found") expectRefusal(response, 404, code, MESSAGES.versionNotFound);
        else expectRefusal(response, 422, code, MESSAGES.notPublished);
        expect(calls, write).toEqual([]);
      }
      expect(opamp.fake.snapshotOf(world.organizationId)).toEqual(before);
    });

    it("refuses an assignment or a pin naming another member's draft for the contributor too, but takes another member's published version", async () => {
      const world = await aWorld();
      const adminsDraft = await draftVersion(world.organizationId, world.admin.userId);
      for (const [, method, url, payload] of versionWrites(world, adminsDraft.versionId)) {
        expectRefusal(await send(world.contributor, method, url, payload), 404, "configuration_version_not_found");
      }
      expect(calls).toEqual([]);
      // The admin's published configuration is everyone's to assign.
      for (const [write, method, url, payload] of versionWrites(world, world.published.versionId)) {
        const response = await send(world.contributor, method, url, payload);
        expect(response.statusCode, write).toBe(method === "POST" && url.endsWith("/groups") ? 201 : 200);
      }
    });

    it("refuses a pin of an import 400 invalid_request, single and bulk, calling nothing", async () => {
      const world = await aWorld();
      const before = opamp.fake.snapshotOf(world.organizationId);
      const collectors = `${fleetPath(world.organizationId, world.fleetId)}/collectors`;
      const importPin = { kind: "import", importId: randomUUID() };

      expectRefusal(await send(world.admin, "PATCH", `${collectors}/${world.collector.id}`, { pin: importPin }), 400, "invalid_request");
      expectRefusal(await send(world.admin, "POST", `${collectors}/pin`, { collectorIds: [world.collector.id], pin: importPin }), 400, "invalid_request");
      expect(calls).toEqual([]);
      expect(opamp.fake.snapshotOf(world.organizationId)).toEqual(before);
    });

    it("puts the configuration and version beside each publication id a reply names, null where the platform holds none (an orphan, a deleted configuration)", async () => {
      const world = await aWorld();
      const second = await publishedVersion(world.organizationId, world.contributor.userId, { label: null, versionNumber: 1 });
      // An orphan: a published copy the opamp-server holds with no platform version recording it.
      const orphan = randomUUID();
      await postPublication(world.organizationId, orphan, { id: randomUUID(), name: "gone" }, { id: randomUUID(), number: 1, label: null });
      const fleet = fleetPath(world.organizationId, world.fleetId);

      // The group assigned the first; one collector pinned to the second, served the first; one pinned to the orphan.
      await send(world.admin, "PATCH", `${fleet}/groups/${world.group.id}`, { assignedVersionId: world.published.versionId });
      const pinnedToOrphan = opamp.fake.enrollCollector(world.organizationId, world.fleetId, { groupId: world.group.id });
      expect((await opamp.client.updateCollectorInstance(world.organizationId, world.fleetId, pinnedToOrphan.id, { pin: { kind: "publication", id: orphan } })).kind).toBe("updated");
      await send(world.admin, "PATCH", `${fleet}/collectors/${world.collector.id}`, { pin: { kind: "version", versionId: second.versionId } });
      opamp.fake.setCollectorState(world.organizationId, world.collector.id, { served: { kind: "publication", id: world.published.publicationId } });
      const inGroup = opamp.fake.enrollCollector(world.organizationId, world.fleetId, { groupId: world.group.id });
      // One whose served source is gone (the opamp-server names neither its kind nor its id).
      const servedGone = opamp.fake.enrollCollector(world.organizationId, world.fleetId, { groupId: world.group.id });
      opamp.fake.setCollectorState(world.organizationId, servedGone.id, { served: { kind: null, sha256: "b".repeat(64), at: null } });
      calls = [];

      const list = await send(world.admin, "GET", `${fleet}/collectors?sort=name`);
      const byId = new Map(list.json<{ collectors: CollectorBody[] }>().collectors.map((c) => [c.id, c]));
      expect(byId.get(world.collector.id)).toMatchObject({
        pin: { kind: "version", versionId: second.versionId, publishedVersionId: second.publicationId, version: expectedVersion(second) },
        resolution: { from: "pinnedVersion", publishedVersionId: second.publicationId, version: expectedVersion(second) },
        served: { kind: "version", publishedVersionId: world.published.publicationId, version: expectedVersion(world.published) },
      });
      // An orphan: its published version's id, and no version (so no versionId to send back).
      expect(byId.get(pinnedToOrphan.id)).toMatchObject({
        pin: { kind: "version", versionId: null, publishedVersionId: orphan, version: null },
        resolution: { from: "pinnedVersion", publishedVersionId: orphan, version: null },
      });
      expect(byId.get(inGroup.id)).toMatchObject({
        pin: null,
        resolution: { from: "groupVersion", publishedVersionId: world.published.publicationId, version: expectedVersion(world.published) },
      });
      // Gone: what the opamp-server's API documents as a deleted published version.
      expect(byId.get(servedGone.id)?.served).toEqual({ kind: "version", publishedVersionId: null, sha256: "b".repeat(64), at: null, version: null });
      expect(operations()).toEqual(["listCollectorInstances"]);

      // A reply naming an import as what was served (crafted: the opamp-server sends none)
      // isn't the API's: the client refuses it, and the platform answers the one 503.
      const craftingClient = createOpampServerClient({
        url: opamp.fake.url,
        secret: opamp.fake.secret,
        fetch: async (input, init) => {
          const real = await fetch(input, init);
          const body = (await real.json()) as Record<string, unknown>;
          const served = { kind: "import", id: randomUUID(), sha256: "c".repeat(64), at: null };
          return new Response(JSON.stringify({ ...body, served }), { status: real.status, headers: { "content-type": "application/json" } });
        },
      });
      hooks.getCollectorInstance = (...args: unknown[]) =>
        craftingClient.getCollectorInstance(...(args as Parameters<OpampServerClient["getCollectorInstance"]>));
      const crafted = await send(world.admin, "GET", `${fleet}/collectors/${servedGone.id}`);
      expectRefusal(crafted, 503, "fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE);
      hooks = {};

      // A configuration deleted since: its published copy stays assigned, with nothing beside it.
      await softDelete(world.published.configurationId);
      const group = await send(world.admin, "GET", `${fleet}/groups/${world.group.id}`);
      expect(group.json<{ group: GroupBody }>().group).toMatchObject({
        assignedPublishedVersionId: world.published.publicationId,
        assignedVersion: null,
      });
      // Another organization's published copy is nothing to this one's either: a reply naming it (the
      // opamp-server never assigns one, so the reply is crafted) has nothing beside it.
      const theirs = await team();
      const their = await publishedVersion(theirs.organizationId, theirs.admin.userId, { name: `THEIR-CONFIGURATION-${randomUUID()}` });
      hooks.getCollectorGroup = async (...args: unknown[]) => {
        const real = await opamp.client.getCollectorGroup(...(args as Parameters<OpampServerClient["getCollectorGroup"]>));
        if (real.kind !== "found") throw new Error(`the group wasn't found: ${real.kind}`);
        return { ...real, group: { ...real.group, assignedPublicationId: their.publicationId } };
      };
      const reread = await send(world.admin, "GET", `${fleet}/groups/${world.group.id}`);
      expect(reread.json<{ group: GroupBody }>().group).toMatchObject({ assignedPublishedVersionId: their.publicationId, assignedVersion: null });
      expect(reread.body).not.toContain(their.configurationName);
    });

    it("looks the versions a reply names up in one query: one for a page of 100 collectors, none for a reply naming none", async () => {
      const world = await aWorld();
      const fleet = fleetPath(world.organizationId, world.fleetId);
      // Nothing assigned or pinned yet: no publication id in any reply, so no lookup.
      expect((await send(world.admin, "GET", `${fleet}/collectors?limit=100`)).statusCode).toBe(200);
      expect((await send(world.admin, "GET", `${fleet}/collectors/${world.collector.id}`)).statusCode).toBe(200);
      expect((await send(world.admin, "GET", `${fleet}/groups`)).statusCode).toBe(200);
      expect((await send(world.admin, "GET", `${fleet}/groups/${world.group.id}`)).statusCode).toBe(200);
      expect(reverseLookups.count).toBe(0);

      // The group assigned a version, then 99 more collectors in it: 100, each resolving the group's version.
      expect((await send(world.admin, "PATCH", `${fleet}/groups/${world.group.id}`, { assignedVersionId: world.published.versionId })).statusCode).toBe(200);
      expect(reverseLookups.count).toBe(1);
      const second = await publishedVersion(world.organizationId, world.admin.userId, { versionNumber: 1 });
      for (let index = 0; index < 99; index++) {
        const enrolled = opamp.fake.enrollCollector(world.organizationId, world.fleetId, { groupId: world.group.id });
        if (index % 3 === 0) {
          // A third pinned to another version, and served the group's: three publication ids each.
          expect((await opamp.client.updateCollectorInstance(world.organizationId, world.fleetId, enrolled.id, { pin: { kind: "publication", id: second.publicationId } })).kind).toBe("updated");
          opamp.fake.setCollectorState(world.organizationId, enrolled.id, { served: { kind: "publication", id: world.published.publicationId } });
        }
      }
      reverseLookups.count = 0;
      const page = await send(world.admin, "GET", `${fleet}/collectors?limit=100`);
      expect(page.statusCode).toBe(200);
      const collectors = page.json<{ collectors: CollectorBody[] }>().collectors;
      expect(collectors).toHaveLength(100);
      expect(collectors.every((collector) => collector.resolution !== null && "version" in collector.resolution && collector.resolution.version !== null)).toBe(true);
      expect(reverseLookups.count).toBe(1);

      reverseLookups.count = 0;
      expect((await send(world.admin, "GET", `${fleet}/groups`)).statusCode).toBe(200);
      expect((await send(world.admin, "GET", `${fleet}/collectors/${world.collector.id}`)).statusCode).toBe(200);
      expect((await send(world.admin, "GET", usagePath(world.organizationId, world.published.configurationId))).statusCode).toBe(200);
      expect(reverseLookups.count).toBe(3);
    });

    it("answers a 422 publication_not_found for a version the platform resolved 503, logged at error with ids: the two sides disagree", async () => {
      const world = await aWorld();
      // The opamp-server lost the published copy the platform still records.
      expect((await opamp.client.deletePublication(world.organizationId, world.published.publicationId)).kind).toBe("deleted");
      const fleet = fleetPath(world.organizationId, world.fleetId);
      const writes = [
        ["createCollectorGroup", "POST", `${fleet}/groups`, { name: "lost", assignedVersionId: world.published.versionId }],
        ["updateCollectorGroup", "PATCH", `${fleet}/groups/${world.group.id}`, { assignedVersionId: world.published.versionId }],
        ["updateCollectorInstance", "PATCH", `${fleet}/collectors/${world.collector.id}`, { pin: { kind: "version", versionId: world.published.versionId } }],
        ["pinCollectorInstances", "POST", `${fleet}/collectors/pin`, { collectorIds: [world.collector.id], pin: { kind: "version", versionId: world.published.versionId } }],
      ] as const;
      for (const [operation, method, url, payload] of writes) {
        logLines = [];
        expectRefusal(await send(world.admin, method, url, payload), 503, "fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE);
        expect(logged().find((line) => line.operation === operation)).toMatchObject({
          level: 50,
          msg: MESSAGES.disagreed,
          organizationId: world.organizationId,
          fleetId: world.fleetId,
          versionId: world.published.versionId,
          publicationId: world.published.publicationId,
          result: "publication_not_found",
        });
        expectNotLogged(world.published.configurationName, "TLS on");
      }
    });
  });

  // -------------------------------------------------------------------------

  describe("a group against its fleet's type", () => {
    const VOLUME = { hostPath: "/var/log/journal", hostPathType: "Directory", mountPath: "/var/log/journal", readOnly: true };
    /** A group's annotations holding Kubernetes settings of `role`, beside another client's key. */
    const settings = (role: string, extra: Record<string, unknown> = {}) => ({
      "acme.io/owner": "ops",
      telflo: { kubernetes: { role, namespace: "telemetry", volumes: [VOLUME], ...extra } },
    });
    const MOUNTS = { telflo: { dockerMounts: [{ hostPath: "/var/log", containerPath: "/logs", readOnly: true }] } };

    /** The detail a refusal names: its path and its words. */
    function details(response: LightMyRequestResponse): { instancePath: string; message: string }[] {
      return (response.json<{ error: { details?: { instancePath: string; message: string }[] } }>().error.details ?? []).map(
        ({ instancePath, message }) => ({ instancePath, message }),
      );
    }

    it("takes a Kubernetes fleet's Cluster and gateway pools with their settings, and the Agent's (the Default group's) on its first save, reading the fleet's type first", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId, "kubernetes-supervisor");
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      calls = [];

      const cluster = await send(admin, "POST", groups, { name: "cluster", annotations: settings("cluster") });
      expect(cluster.statusCode).toBe(201);
      expect(cluster.json<{ group: GroupBody }>().group).toMatchObject({ name: "cluster", annotations: settings("cluster") });
      expect(operations()).toEqual(["getFleet", "createCollectorGroup"]);
      expect(calls.at(-1)?.args[2]).toEqual({ name: "cluster", annotations: settings("cluster") });

      calls = [];
      const gateway = await send(admin, "POST", groups, { name: "traces-sampling", annotations: settings("gateway", { replicas: 3 }) });
      expect(gateway.statusCode).toBe(201);
      const gatewayGroup = gateway.json<{ group: GroupBody }>().group;
      expect(gatewayGroup.annotations).toEqual(settings("gateway", { replicas: 3 }));
      expect(operations()).toEqual(["getFleet", "createCollectorGroup"]);

      // The Agent holds no settings until its first save; then the group is read for its role.
      expect((await send(admin, "GET", `${groups}/${defaultGroupId}`)).json<{ group: GroupBody }>().group.annotations).toBeNull();
      calls = [];
      const agent = await send(admin, "PATCH", `${groups}/${defaultGroupId}`, { annotations: settings("node") });
      expect(agent.statusCode).toBe(200);
      expect(agent.json<{ group: GroupBody }>().group.annotations).toEqual(settings("node"));
      expect(operations()).toEqual(["getFleet", "getCollectorGroup", "updateCollectorGroup"]);
      calls = [];
      const scaled = await send(admin, "PATCH", `${groups}/${gatewayGroup.id}`, { annotations: settings("gateway", { replicas: 1000 }) });
      expect(scaled.json<{ group: GroupBody }>().group.annotations).toEqual(settings("gateway", { replicas: 1000 }));
      expect(operations()).toEqual(["getFleet", "getCollectorGroup", "updateCollectorGroup"]);

      // An assignment alone reads nothing first, and keeps the settings.
      calls = [];
      const assigned = await send(admin, "PATCH", `${groups}/${gatewayGroup.id}`, { assignedVersionId: null });
      expect(assigned.statusCode).toBe(200);
      expect(assigned.json<{ group: GroupBody }>().group.annotations).toEqual(settings("gateway", { replicas: 1000 }));
      expect(operations()).toEqual(["updateCollectorGroup"]);
      expect(await auditActions(organizationId)).toEqual(["fleet.created"]);
    });

    // Settings are required only on a write carrying annotations; an assignment alone needs none,
    // even on the Agent, which holds none until its first save.
    it("takes a never-saved Agent's assignment alone, its annotations still null, calling updateCollectorGroup only", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId, "kubernetes-supervisor");
      const published = await publishedVersion(organizationId, admin.userId);
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      calls = [];

      const assigned = await send(admin, "PATCH", `${groups}/${defaultGroupId}`, { assignedVersionId: published.versionId });
      expect(assigned.statusCode).toBe(200);
      expect(assigned.json<{ group: GroupBody }>().group).toMatchObject({
        id: defaultGroupId,
        isDefault: true,
        annotations: null,
        assignedPublishedVersionId: published.publicationId,
        assignedVersion: expectedVersion(published),
      });
      expect(operations()).toEqual(["updateCollectorGroup"]);
      expect(calls[0]?.args[3]).toEqual({ assignedPublicationId: published.publicationId });
      expect((await send(admin, "GET", `${groups}/${defaultGroupId}`)).json<{ group: GroupBody }>().group.annotations).toBeNull();
    });

    it("refuses telflo.kubernetes on a server fleet's group 400 at its path, create and update, once the fleet's type is read, writing nothing", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId);
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      const before = opamp.fake.snapshotOf(organizationId);
      calls = [];

      for (const [method, url, body] of [
        ["POST", groups, { name: "k8s", annotations: settings("gateway") }],
        ["PATCH", `${groups}/${defaultGroupId}`, { annotations: settings("node") }],
        ["PATCH", `${groups}/${defaultGroupId}`, { annotations: { telflo: { ...MOUNTS.telflo, kubernetes: settings("node").telflo.kubernetes } } }],
      ] as const) {
        const refused = await send(admin, method, url, body);
        expectRefusal(refused, 400, "invalid_request", MESSAGES.kubernetesOnServer);
        expect(details(refused)).toEqual([{ instancePath: "/annotations/telflo/kubernetes", message: "Only a kubernetes-supervisor fleet's groups take it." }]);
      }
      expect(operations()).toEqual(["getFleet", "getFleet", "getFleet"]);
      expect(opamp.fake.snapshotOf(organizationId)).toEqual(before);
    });

    it("refuses telflo.dockerMounts on a Kubernetes fleet's group 400 at its path, create and update (the Agent's too), writing nothing", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId, "kubernetes-supervisor");
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      const before = opamp.fake.snapshotOf(organizationId);
      calls = [];

      for (const [method, url, body] of [
        ["POST", groups, { name: "gateway", annotations: MOUNTS }],
        ["POST", groups, { name: "gateway", annotations: { telflo: { ...MOUNTS.telflo, kubernetes: settings("gateway").telflo.kubernetes } } }],
        ["PATCH", `${groups}/${defaultGroupId}`, { annotations: MOUNTS }],
      ] as const) {
        const refused = await send(admin, method, url, body);
        expectRefusal(refused, 400, "invalid_request", MESSAGES.dockerMountsOnKubernetes);
        expect(details(refused)).toEqual([{ instancePath: "/annotations/telflo/dockerMounts", message: "Only a server fleet's groups take it." }]);
      }
      expect(operations()).toEqual(["getFleet", "getFleet", "getFleet"]);
      expect(opamp.fake.snapshotOf(organizationId)).toEqual(before);
    });

    it.each([
      ["node", "node, cluster, telflo-node and telflo-cluster are reserved: choose another name."],
      ["telflo-cluster", "node, cluster, telflo-node and telflo-cluster are reserved: choose another name."],
      ["Traces", "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."],
      ["1-traces", "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."],
      ["Default", "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."],
      ["a".repeat(53), "Gateway name must be 52 characters or fewer."],
    ])("refuses a Kubernetes fleet's group created as %j 400 at name: neither the Cluster nor a gateway's name", async (name, words) => {
      const { organizationId, admin } = await team();
      const { fleetId } = await created(admin, organizationId, "kubernetes-supervisor");
      const before = opamp.fake.snapshotOf(organizationId);
      calls = [];

      const refused = await send(admin, "POST", `${fleetPath(organizationId, fleetId)}/groups`, { name, annotations: settings("gateway") });
      expectRefusal(refused, 400, "invalid_request", MESSAGES.kubernetesName);
      expect(details(refused)).toEqual([{ instancePath: "/name", message: words }]);
      // The words never repeat the name (but for the reserved names, which they list).
      if (!["node", "telflo-cluster"].includes(name)) expect(refused.body).not.toContain(name);
      expect(operations()).toEqual(["getFleet"]);
      expect(opamp.fake.snapshotOf(organizationId)).toEqual(before);
    });

    it("refuses a create whose settings name another role 400 at telflo.kubernetes.role: the Cluster's cluster, a gateway's gateway, node never created", async () => {
      const { organizationId, admin } = await team();
      const { fleetId } = await created(admin, organizationId, "kubernetes-supervisor");
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      const before = opamp.fake.snapshotOf(organizationId);
      calls = [];

      for (const [body, role] of [
        [{ name: "cluster", annotations: settings("gateway") }, "cluster"],
        [{ name: "cluster", annotations: settings("node") }, "cluster"],
        [{ name: "traces", annotations: settings("node") }, "gateway"],
        [{ name: "traces", annotations: settings("cluster") }, "gateway"],
      ] as const) {
        const refused = await send(admin, "POST", groups, body);
        expectRefusal(refused, 400, "invalid_request", MESSAGES.kubernetesRole);
        expect(details(refused)).toEqual([{ instancePath: "/annotations/telflo/kubernetes/role", message: `Must be ${role}: the group's role on its fleet.` }]);
      }
      expect(operations()).toEqual(Array(4).fill("getFleet"));
      expect(opamp.fake.snapshotOf(organizationId)).toEqual(before);
    });

    // Once written, a Kubernetes group's settings are never dropped by a write of its annotations.
    it("refuses a Kubernetes group's create or annotations update without its settings 400 at telflo.kubernetes, keeping what is saved", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId, "kubernetes-supervisor");
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      const gateway = await groupIn(admin, organizationId, fleetId, { name: "traces", annotations: settings("gateway", { replicas: 3 }) });
      const before = opamp.fake.snapshotOf(organizationId);
      calls = [];

      const withoutSettings = [undefined, null, {}, { other: 1 }, { telflo: {} }, { "acme.io/owner": "ops", telflo: {} }];
      for (const annotations of withoutSettings) {
        for (const name of ["cluster", "spans"]) {
          const refused = await send(admin, "POST", groups, annotations === undefined ? { name } : { name, annotations });
          expectRefusal(refused, 400, "invalid_request", MESSAGES.kubernetesSettings);
          expect(details(refused)).toEqual([{ instancePath: "/annotations/telflo/kubernetes", message: "Kubernetes settings are required." }]);
        }
        if (annotations === undefined) continue;
        // The gateway's saved settings, and the Agent before its first save, alike: no group is read.
        for (const groupId of [gateway.id, defaultGroupId]) {
          const refused = await send(admin, "PATCH", `${groups}/${groupId}`, { annotations });
          expectRefusal(refused, 400, "invalid_request", MESSAGES.kubernetesSettings);
          expect(details(refused)).toEqual([{ instancePath: "/annotations/telflo/kubernetes", message: "Kubernetes settings are required." }]);
        }
      }
      expect(operations()).toEqual(Array(2 * withoutSettings.length + 2 * (withoutSettings.length - 1)).fill("getFleet"));
      expect(opamp.fake.snapshotOf(organizationId)).toEqual(before);
      expect((await send(admin, "GET", `${groups}/${gateway.id}`)).json<{ group: GroupBody }>().group.annotations).toEqual(settings("gateway", { replicas: 3 }));
    });

    it("refuses an update's settings naming another role than the group's on its fleet: the Agent's node, the Cluster's cluster, a gateway's gateway", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId, "kubernetes-supervisor");
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      const cluster = await groupIn(admin, organizationId, fleetId, { name: "cluster", annotations: settings("cluster") });
      const gateway = await groupIn(admin, organizationId, fleetId, { name: "traces", annotations: settings("gateway") });
      const before = opamp.fake.snapshotOf(organizationId);
      calls = [];

      for (const [groupId, sent, role] of [
        [defaultGroupId, "gateway", "node"],
        [defaultGroupId, "cluster", "node"],
        [cluster.id, "gateway", "cluster"],
        [gateway.id, "cluster", "gateway"],
        [gateway.id, "node", "gateway"],
      ] as const) {
        const refused = await send(admin, "PATCH", `${groups}/${groupId}`, { annotations: settings(sent) });
        expectRefusal(refused, 400, "invalid_request", MESSAGES.kubernetesRole);
        expect(details(refused)).toEqual([{ instancePath: "/annotations/telflo/kubernetes/role", message: `Must be ${role}: the group's role on its fleet.` }]);
      }
      expect(operations()).toEqual(Array(5).fill(["getFleet", "getCollectorGroup"]).flat());
      expect(opamp.fake.snapshotOf(organizationId)).toEqual(before);
    });

    it("refuses any rename of a Kubernetes fleet's group 409 collector_group_name_fixed, its own name and the Agent's included, without reading the group", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId, "kubernetes-supervisor");
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      const gateway = await groupIn(admin, organizationId, fleetId, { name: "traces", annotations: settings("gateway") });
      const before = opamp.fake.snapshotOf(organizationId);
      calls = [];

      for (const [groupId, body] of [
        [gateway.id, { name: "spans" }],
        [gateway.id, { name: "traces" }],
        [gateway.id, { name: "spans", annotations: settings("gateway") }],
        [defaultGroupId, { name: "Default" }],
        [randomUUID(), { name: "spans" }],
      ] as const) {
        expectRefusal(await send(admin, "PATCH", `${groups}/${groupId}`, body), 409, "collector_group_name_fixed", MESSAGES.nameFixed);
      }
      expect(operations()).toEqual(Array(5).fill("getFleet"));
      expect(opamp.fake.snapshotOf(organizationId)).toEqual(before);
    });

    it("answers a settings write's group read: a group the fleet doesn't hold 404 collector_group_not_found, its other failures 503, writing nothing", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId, "kubernetes-supervisor");
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      const before = opamp.fake.snapshotOf(organizationId);
      calls = [];

      expectRefusal(await send(admin, "PATCH", `${groups}/${randomUUID()}`, { annotations: settings("gateway") }), 404, "collector_group_not_found", MESSAGES.groupNotFound);
      expect(operations()).toEqual(["getFleet", "getCollectorGroup"]);
      for (const fault of ["error_500", "malformed_reply"] as const) {
        calls = [];
        logLines = [];
        opamp.fake.nextFault(fault, "getCollectorGroup");
        expectRefusal(await send(admin, "PATCH", `${groups}/${defaultGroupId}`, { annotations: settings("node") }), 503, "fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE);
        expect(operations()).toEqual(["getFleet", "getCollectorGroup"]);
        expect(logged().find((line) => line.operation === "getCollectorGroup")).toMatchObject({ organizationId, fleetId, groupId: defaultGroupId });
        if (fault === "malformed_reply") expect(opamp.fake.takeViolations()).toHaveLength(1);
      }
      expect(opamp.fake.snapshotOf(organizationId)).toEqual(before);
    });

    it("reads back a group whose telflo key the platform can't read (another client's write) as it is stored", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId, "kubernetes-supervisor");
      const unreadable = { telflo: { kubernetes: { role: "sidecar", namespace: "Not A Label", volumes: "none" }, helm: true } };
      expect((await opamp.client.updateCollectorGroup(organizationId, fleetId, defaultGroupId, { annotations: unreadable })).kind).toBe("updated");
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;

      expect((await send(admin, "GET", `${groups}/${defaultGroupId}`)).json<{ group: GroupBody }>().group.annotations).toEqual(unreadable);
      expect((await send(admin, "GET", groups)).json<{ groups: GroupBody[] }>().groups[0]?.annotations).toEqual(unreadable);
      // The next save replaces it.
      const saved = await send(admin, "PATCH", `${groups}/${defaultGroupId}`, { annotations: settings("node") });
      expect(saved.json<{ group: GroupBody }>().group.annotations).toEqual(settings("node"));
    });

    it("never logs a namespace, a gateway's name or a volume's paths, nor writes them into an error answer (configuration text)", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId, "kubernetes-supervisor");
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      const canary = (role: string, extra: Record<string, unknown> = {}) => ({
        telflo: {
          kubernetes: {
            role,
            namespace: "canary-ns-2c9d",
            volumes: [{ ...VOLUME, hostPath: "/canary-host-5a1b", mountPath: "/canary-mount-8e4f" }],
            ...extra,
          },
        },
      });
      expect((await send(admin, "POST", groups, { name: "canary-gw-7f3e", annotations: canary("gateway") })).statusCode).toBe(201);
      const refusals = [
        await send(admin, "POST", groups, { name: "canary-gx-3b6a", annotations: canary("node") }),
        await send(admin, "POST", groups, { name: "Canary-Gy-4d0c", annotations: canary("gateway") }),
        await send(admin, "PATCH", `${groups}/${defaultGroupId}`, { name: "canary-gz-9a7e", annotations: canary("node") }),
        await send(admin, "PATCH", `${groups}/${defaultGroupId}`, { annotations: canary("node", { replicas: 2 }) }),
        await send(admin, "POST", groups, { name: "canary-gq-1f5b", annotations: { telflo: { kubernetes: { ...canary("gateway").telflo.kubernetes, namespace: "Canary-Ns-6e2a" } } } }),
      ];
      expect(refusals.map((response) => response.statusCode)).toEqual([400, 400, 409, 400, 400]);
      const privates = ["canary-ns-2c9d", "/canary-host-5a1b", "/canary-mount-8e4f", "canary-gw-7f3e", "canary-gx-3b6a", "Canary-Gy-4d0c", "canary-gz-9a7e", "canary-gq-1f5b", "Canary-Ns-6e2a"];
      for (const response of refusals) for (const value of privates) expect(response.body).not.toContain(value);
      expectNotLogged(...privates);
      expect(await auditText(organizationId)).not.toMatch(/canary/i);
    });

    it("answers the fleet read's fleet_not_found or organization_not_found 404 fleet_not_found, and its other failures 503, writing nothing", async () => {
      const { organizationId, admin } = await team();
      const create = { name: "traces", annotations: settings("gateway") };
      // Unregistered: the opamp-server answers organization_not_found.
      expectRefusal(await send(admin, "POST", `${fleetPath(organizationId, randomUUID())}/groups`, create), 404, "fleet_not_found", MESSAGES.fleetNotFound);
      expect(operations()).toEqual(["getFleet"]);
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: null });

      const { fleetId, defaultGroupId } = await created(admin, organizationId, "kubernetes-supervisor");
      calls = [];
      expectRefusal(await send(admin, "POST", `${fleetPath(organizationId, randomUUID())}/groups`, create), 404, "fleet_not_found");
      expectRefusal(await send(admin, "PATCH", `${fleetPath(organizationId, randomUUID())}/groups/${defaultGroupId}`, { name: "x" }), 404, "fleet_not_found");
      expect(operations()).toEqual(["getFleet", "getFleet"]);

      const before = opamp.fake.snapshotOf(organizationId);
      for (const fault of ["error_500", "malformed_reply"] as const) {
        calls = [];
        logLines = [];
        opamp.fake.nextFault(fault, "getFleet");
        expectRefusal(await send(admin, "POST", `${fleetPath(organizationId, fleetId)}/groups`, create), 503, "fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE);
        expect(operations()).toEqual(["getFleet"]);
        expect(logged().find((line) => line.operation === "getFleet")).toMatchObject({ organizationId, fleetId });
        if (fault === "malformed_reply") expect(opamp.fake.takeViolations()).toHaveLength(1);
      }
      expect(opamp.fake.snapshotOf(organizationId)).toEqual(before);
    });

    /** A Kubernetes group's create, and an update of the Agent's settings: the fleet (and the group) read first, then the write. */
    const KUBERNETES_WRITES = {
      "a create": {
        status: 201,
        operations: ["getFleet", "createCollectorGroup"],
        send: (person: Person, organizationId: string, fleet: { fleetId: string; defaultGroupId: string }, n: number, on: FastifyInstance = server) =>
          send(person, "POST", `${fleetPath(organizationId, fleet.fleetId)}/groups`, { name: `k8s-${n}`, annotations: settings("gateway") }, on),
      },
      "an update": {
        status: 200,
        operations: ["getFleet", "getCollectorGroup", "updateCollectorGroup"],
        send: (person: Person, organizationId: string, fleet: { fleetId: string; defaultGroupId: string }, n: number, on: FastifyInstance = server) =>
          send(person, "PATCH", `${fleetPath(organizationId, fleet.fleetId)}/groups/${fleet.defaultGroupId}`, { annotations: settings("node", { volumes: [{ ...VOLUME, mountPath: `/m${n}` }] }) }, on),
      },
    } as const;

    it.each(Object.keys(KUBERNETES_WRITES) as (keyof typeof KUBERNETES_WRITES)[])(
      "spends one write and one in-flight slot for the reads and %s together, not two",
      async (which) => {
        const write = KUBERNETES_WRITES[which];
        const limited = build({ ...TEST_RATE_LIMITS, fleetWritesPerUser: { max: 2, windowMs: 60_000 } });
        await limited.ready();
        try {
          const { organizationId, admin } = await team(limited);
          // The fleet's create spends a bearer reply, not a write.
          const fleet = await created(admin, organizationId, "kubernetes-supervisor", limited);
          calls = [];
          expect((await write.send(admin, organizationId, fleet, 1, limited)).statusCode).toBe(write.status);
          expect((await write.send(admin, organizationId, fleet, 2, limited)).statusCode).toBe(write.status);
          expect(operations()).toEqual([...write.operations, ...write.operations]);
          calls = [];
          expectRefusal(await write.send(admin, organizationId, fleet, 3, limited), 429, "rate_limited");
          expect(calls).toEqual([]);
        } finally {
          await limited.close();
        }

        // In flight: with 15 of the person's requests held, the read and the write together fit in the last slot.
        const { organizationId, admin } = await team();
        const fleet = await created(admin, organizationId, "kubernetes-supervisor");
        const groups = `${fleetPath(organizationId, fleet.fleetId)}/groups`;
        const gate = createGate();
        let held = 0;
        let allHeld!: () => void;
        const heldAll = new Promise<void>((resolve) => (allHeld = resolve));
        hooks.listCollectorGroups = async (...args: unknown[]) => {
          if (++held === 15) allHeld();
          await gate.hold();
          return opamp.client.listCollectorGroups(...(args as Parameters<OpampServerClient["listCollectorGroups"]>));
        };
        const reads = Array.from({ length: 15 }, () => send(admin, "GET", groups));
        try {
          await Promise.race([heldAll, ...reads]);
          expect(held).toBe(15);
          calls = [];
          expect((await write.send(admin, organizationId, fleet, 4)).statusCode).toBe(write.status);
          expect(operations()).toEqual(write.operations);

          // A 16th held: no slot is left for it, and nothing is read.
          let sixteenth!: () => void;
          const sixteenHeld = new Promise<void>((resolve) => (sixteenth = resolve));
          hooks.listCollectorGroups = async (...args: unknown[]) => {
            sixteenth();
            await gate.hold();
            return opamp.client.listCollectorGroups(...(args as Parameters<OpampServerClient["listCollectorGroups"]>));
          };
          const one = send(admin, "GET", groups);
          reads.push(one);
          await Promise.race([sixteenHeld, one]);
          calls = [];
          expectRefusal(await write.send(admin, organizationId, fleet, 5), 429, "rate_limited");
          expect(calls).toEqual([]);
        } finally {
          gate.release();
        }
        expect((await Promise.all(reads)).map((response) => response.statusCode)).toEqual(Array(16).fill(200));
      },
    );
  });

  // -------------------------------------------------------------------------

  describe("a group's annotations", () => {
    const MOUNT = { hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true };
    const ANNOTATIONS = { "acme.io/owner": { team: "ops", n: [1.5, 100] }, telflo: { dockerMounts: [MOUNT] } };

    it(
      "passes them through on a server fleet's group: created, read, kept by a rename, replaced whole, cleared; the fleet's type read for each but an assignment",
      async () => {
        const { organizationId, admin } = await team();
        const { fleetId, defaultGroupId } = await created(admin, organizationId);
        const groups = `${fleetPath(organizationId, fleetId)}/groups`;
        calls = [];

        const create = await send(admin, "POST", groups, { name: "edge", annotations: ANNOTATIONS });
        expect(create.statusCode).toBe(201);
        const group = create.json<{ group: GroupBody }>().group;
        expect(group.annotations).toEqual(ANNOTATIONS);
        expect(calls[1]?.args[2]).toEqual({ name: "edge", annotations: ANNOTATIONS });
        expect((await send(admin, "GET", `${groups}/${group.id}`)).json<{ group: GroupBody }>().group.annotations).toEqual(ANNOTATIONS);
        const listed = (await send(admin, "GET", groups)).json<{ groups: GroupBody[] }>().groups;
        expect(listed.map((g) => [g.name, g.annotations])).toEqual([
          ["Default", null],
          ["edge", ANNOTATIONS],
        ]);

        const renamed = await send(admin, "PATCH", `${groups}/${group.id}`, { name: "edges" });
        expect(renamed.json<{ group: GroupBody }>().group.annotations).toEqual(ANNOTATIONS);
        expect(calls.at(-1)?.args[3]).toEqual({ name: "edges" });
        const replaced = await send(admin, "PATCH", `${groups}/${group.id}`, { annotations: { other: true } });
        expect(replaced.json<{ group: GroupBody }>().group.annotations).toEqual({ other: true });
        expect(calls.at(-1)?.args[3]).toEqual({ annotations: { other: true } });
        const cleared = await send(admin, "PATCH", `${groups}/${group.id}`, { annotations: null });
        expect(cleared.json<{ group: GroupBody }>().group.annotations).toBeNull();
        expect(calls.at(-1)?.args[3]).toEqual({ annotations: null });
        // The Default group's too.
        const onDefault = await send(admin, "PATCH", `${groups}/${defaultGroupId}`, { annotations: ANNOTATIONS });
        expect(onDefault.json<{ group: GroupBody }>().group.annotations).toEqual(ANNOTATIONS);
        // A create, a rename and each annotations write (5) read the fleet's type; a server group's never reads the group.
        expect(operations().filter((operation) => operation === "getFleet")).toHaveLength(5);
        expect(operations().filter((operation) => operation === "getCollectorGroup")).toHaveLength(1); // The test's own read.
        expect(await auditActions(organizationId)).toEqual(["fleet.created"]);
      },
    );

    it("refuses annotations the contract refuses 400 invalid_request, each mount's problem at its path, before any call", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId);
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      const before = opamp.fake.snapshotOf(organizationId);
      calls = [];

      const mounts = { telflo: { dockerMounts: [{ ...MOUNT, hostPath: "relative" }, { ...MOUNT, containerPath: "/app/opamp" }, MOUNT] } };
      for (const [method, url, body] of [
        ["POST", groups, { name: "edge", annotations: mounts }],
        ["PATCH", `${groups}/${defaultGroupId}`, { annotations: mounts }],
      ] as const) {
        const refused = await send(admin, method, url, body);
        expectRefusal(refused, 400, "invalid_request");
        expect(refused.json<{ error: { details: { instancePath: string; message: string }[] } }>().error.details).toEqual([
          expect.objectContaining({ instancePath: "/annotations/telflo/dockerMounts/0/hostPath", message: "Use an absolute path, starting with /." }),
          expect.objectContaining({
            instancePath: "/annotations/telflo/dockerMounts/1/containerPath",
            message: "Use a path outside /app: the image keeps its own files there.",
          }),
          expect.objectContaining({ instancePath: "/annotations/telflo/dockerMounts/2/containerPath", message: "Each container path once." }),
        ]);
      }
      for (const annotations of [[], "telflo", { telflo: { mounts: [] } }, { big: "v".repeat(16_380) }]) {
        expectRefusal(await send(admin, "PATCH", `${groups}/${defaultGroupId}`, { annotations }), 400, "invalid_request");
        expect(detailPaths(await send(admin, "POST", groups, { name: "edge", annotations }))[0]).toMatch(/^\/annotations/);
      }
      // 10,000 objects deep, as the body's text (no JSON.stringify of a deep value): refused by its depth, first.
      const deep = `{"annotations":${'{"d":'.repeat(10_000)}1${"}".repeat(10_000)}}`;
      const refused = await server.inject({
        method: "PATCH",
        url: `${groups}/${defaultGroupId}`,
        headers: { ...csrfHeaders, "content-type": "application/json" },
        cookies: { telflo_access: admin.access },
        payload: deep,
      });
      expectRefusal(refused, 400, "invalid_request");
      expect(refused.json<{ error: { details: { instancePath: string; message: string }[] } }>().error.details).toEqual([
        expect.objectContaining({ instancePath: "/annotations", message: "Must nest at most 64 arrays and objects deep." }),
      ]);
      expect(calls).toEqual([]);
      expect(opamp.fake.snapshotOf(organizationId)).toEqual(before);
    });

    it("never logs them or writes them into an error answer (configuration text: paths)", async () => {
      const { organizationId, admin } = await team();
      const { fleetId, defaultGroupId } = await created(admin, organizationId);
      const groups = `${fleetPath(organizationId, fleetId)}/groups`;
      const canary = { "canary-key-5e1d": "canary-value-0b7c", telflo: { dockerMounts: [{ ...MOUNT, hostPath: "/canary-host-4f2a" }] } };
      expect((await send(admin, "POST", groups, { name: "edge", annotations: canary })).statusCode).toBe(201);
      expect((await send(admin, "PATCH", `${groups}/${defaultGroupId}`, { annotations: canary })).statusCode).toBe(200);
      const refused = await send(admin, "PATCH", `${groups}/${defaultGroupId}`, {
        annotations: { ...canary, telflo: { dockerMounts: [{ ...MOUNT, containerPath: "/canary-container 9d3e" }] } },
      });
      expectRefusal(refused, 400, "invalid_request");
      for (const value of ["canary-key-5e1d", "canary-value-0b7c", "/canary-host-4f2a", "canary-container"]) {
        expect(refused.body).not.toContain(value);
      }
      expectNotLogged("canary-key-5e1d", "canary-value-0b7c", "/canary-host-4f2a", "canary-container");
    });
  });

  describe("the refusals that are the person's to fix", () => {
    it("answers a name another group of the fleet has 409, and the Default group's rename or delete 409 collector_group_is_default", async () => {
      const world = await aWorld();
      const groups = `${fleetPath(world.organizationId, world.fleetId)}/groups`;
      expectRefusal(
        await send(world.admin, "POST", groups, { name: world.group.name }),
        409,
        "collector_group_name_taken",
        "Another of the fleet's collector groups has this name.",
      );
      expectRefusal(await send(world.admin, "PATCH", `${groups}/${world.group.id}`, { name: "Default" }), 409, "collector_group_name_taken");
      expectRefusal(
        await send(world.admin, "PATCH", `${groups}/${world.defaultGroupId}`, { name: "renamed" }),
        409,
        "collector_group_is_default",
        "The fleet's Default group can't be renamed or deleted.",
      );
      expectRefusal(await send(world.admin, "DELETE", `${groups}/${world.defaultGroupId}`), 409, "collector_group_is_default");
    });

    it("answers a collector name another of the organization's collectors has 409, and a group the fleet doesn't hold 404", async () => {
      const world = await aWorld();
      const { fleetId: otherFleet } = await created(world.admin, world.organizationId);
      const elsewhere = opamp.fake.enrollCollector(world.organizationId, otherFleet, { name: "edge-elsewhere" });
      const collector = `${fleetPath(world.organizationId, world.fleetId)}/collectors/${world.collector.id}`;
      expectRefusal(
        await send(world.admin, "PATCH", collector, { name: elsewhere.name }),
        409,
        "collector_name_taken",
        "Another of the organization's collectors has this name.",
      );
      expectRefusal(await send(world.admin, "PATCH", collector, { groupId: randomUUID() }), 404, "collector_group_not_found");
    });

    it("answers an organization the opamp-server doesn't know as one with no fleets, and its configuration's usage as unused", async () => {
      const { organizationId, admin } = await team();
      const fleetId = randomUUID();
      const id = randomUUID();
      for (const [method, url, payload] of taskRoutes(organizationId, fleetId, { group: id, collector: id })) {
        expectRefusal(await send(admin, method, url, payload), 404, "fleet_not_found");
      }
      const configuration = await addConfiguration(ownerDb, { organizationId, created_by_user_id: admin.userId });
      const usage = await send(admin, "GET", usagePath(organizationId, configuration.id));
      expect(usage.json()).toEqual({ usage: { configurationId: configuration.id, inUse: false, publishedVersions: [] } });
      expect(operations()).not.toContain("createOrganization");
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: null });
    });

    it.each([
      ["the collector list", "collectors", "listCollectorInstances"],
      ["a collector's errors", "collectors/:collector/errors", "listCollectorInstanceErrors"],
    ])("pages %s by cursor, and answers a cursor the opamp-server didn't give 400 invalid_request", async (_label, path, operation) => {
      const world = await aWorld();
      opamp.fake.enrollCollector(world.organizationId, world.fleetId);
      opamp.fake.recordCollectorError(world.organizationId, world.collector.id, { message: "worse configuration" });
      const url = `${fleetPath(world.organizationId, world.fleetId)}/${path.replace(":collector", world.collector.id)}`;
      const first = await send(world.admin, "GET", `${url}?limit=1`);
      const page = first.json<{ nextCursor: string }>();
      expect(page.nextCursor).toEqual(expect.any(String));
      const next = await send(world.admin, "GET", `${url}?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`);
      expect(next.json<{ nextCursor: string | null }>().nextCursor).toBeNull();
      logLines = [];
      const bogus = await send(world.admin, "GET", `${url}?cursor=bogus`);
      expectRefusal(bogus, 400, "invalid_request", "The list's cursor isn't valid: reload the list.");
      expect(detailPaths(bogus)).toEqual(["/cursor"]);
      expect(logged().some((line) => line.operation === operation)).toBe(false);
      if (operation === "listCollectorInstances") {
        // Another sort's cursor too.
        expectRefusal(
          await send(world.admin, "GET", `${url}?limit=1&sort=name&cursor=${encodeURIComponent(page.nextCursor)}`),
          400,
          "invalid_request",
        );
      }
      expect(opamp.fake.takeViolations()).toEqual([]);
    });

    it.each([
      ["a group name with an edge space", "POST", "groups", { name: " edge" }],
      ["a group name of 81 characters", "POST", "groups", { name: "a".repeat(81) }],
      ["a publication id instead of a version", "POST", "groups", { name: "edge", assignedPublicationId: randomUUID() }],
      ["a published version's id instead of a version", "PATCH", "groups/:group", { assignedPublishedVersionId: randomUUID() }],
      ["a malformed version id", "POST", "groups", { name: "edge", assignedVersionId: "42" }],
      // The four Kubernetes fields aren't in the request (the settings are the annotations').
      ["a role", "POST", "groups", { name: "edge", role: "gateway" }],
      ["a namespace", "PATCH", "groups/:group", { namespace: "telemetry" }],
      ["replicas", "POST", "groups", { name: "edge", replicas: 1 }],
      ["volumes", "PATCH", "groups/:group", { volumes: null }],
      ["an empty update", "PATCH", "groups/:group", {}],
      ["a null name", "PATCH", "groups/:group", { name: null }],
      ["no collector ids", "POST", "collectors/pin", { collectorIds: [], pin: null }],
      ["501 collector ids", "POST", "collectors/pin", { collectorIds: Array.from({ length: 501 }, () => randomUUID()), pin: null }],
      ["a pin without its field", "POST", "collectors/pin", { collectorIds: [randomUUID()] }],
      ["a raw publication pin", "POST", "collectors/pin", { collectorIds: [randomUUID()], pin: { kind: "publication", id: randomUUID() } }],
      ["a version pin with an import's field", "PATCH", "collectors/:collector", { pin: { kind: "version", importId: randomUUID() } }],
      ["a reply's whole pin sent back", "PATCH", "collectors/:collector", { pin: { kind: "version", versionId: randomUUID(), publishedVersionId: randomUUID(), version: null } }],
      ["a collector name of 201 characters", "PATCH", "collectors/:collector", { name: "a".repeat(201) }],
      ["a collector name with a control character", "PATCH", "collectors/:collector", { name: "edge\u0007" }],
      ["an empty collector update", "PATCH", "collectors/:collector", {}],
    ])("refuses %s 400 invalid_request, calling nothing", async (_label, method, path, payload) => {
      const world = await aWorld();
      const url = `${fleetPath(world.organizationId, world.fleetId)}/${path.replace(":group", world.group.id).replace(":collector", world.collector.id)}`;
      expectRefusal(await send(world.admin, method as Method, url, payload), 400, "invalid_request");
      expect(calls).toEqual([]);
    });

    // The settings' rules are the contract's, so the fleet's type is never read for them.
    it.each([
      ["an unknown role", { role: "sidecar" }],
      ["a namespace that isn't a DNS label", { namespace: "Telemetry" }],
      ["a namespace of 64 characters", { namespace: "a".repeat(64) }],
      ["replicas 0", { replicas: 0 }],
      ["replicas 1001", { replicas: 1001 }],
      ["replicas on the Cluster", { role: "cluster", replicas: 2 }],
      ["33 volumes", { volumes: Array.from({ length: 33 }, (_, index) => ({ hostPath: "/a", hostPathType: "Directory", mountPath: `/m${index}`, readOnly: true })) }],
      ["a volume of another type", { volumes: [{ hostPath: "/a", hostPathType: "BlockDevice", mountPath: "/b", readOnly: true }] }],
      ["a volume's other key", { volumes: [{ type: "hostPath", hostPath: "/a", hostPathType: "Directory", mountPath: "/b", readOnly: true }] }],
      ["two mount paths naming the same volume", { volumes: ["/var/log", "/var-log"].map((mountPath) => ({ hostPath: "/a", hostPathType: "Directory", mountPath, readOnly: true })) }],
      ["the Agent mounting /var/log/pods", { role: "node", volumes: [{ hostPath: "/var/log/pods", hostPathType: "Directory", mountPath: "/var/log/pods", readOnly: true }] }],
    ] as [string, Record<string, unknown>][])("refuses Kubernetes settings with %s 400 invalid_request, calling nothing", async (_label, fields) => {
      const world = await aWorld();
      const kubernetes = { role: "gateway", namespace: "telemetry", volumes: [], ...fields };
      const groups = `${fleetPath(world.organizationId, world.fleetId)}/groups`;
      for (const [method, url, payload] of [
        ["POST", groups, { name: "edge", annotations: { telflo: { kubernetes } } }],
        ["PATCH", `${groups}/${world.group.id}`, { annotations: { telflo: { kubernetes } } }],
      ] as const) {
        const refused = await send(world.admin, method, url, payload);
        expectRefusal(refused, 400, "invalid_request");
        expect(detailPaths(refused).every((path) => path.startsWith("/annotations/telflo/kubernetes"))).toBe(true);
      }
      expect(calls).toEqual([]);
    });

    it.each([
      ["q over 100 characters", "collectors?q=" + "a".repeat(101)],
      ["an unknown sort", "collectors?sort=size"],
      ["a malformed group id", "collectors?groupId=42"],
      ["a limit over 100", "collectors?limit=101"],
      ["an unknown parameter", "collectors?status=online"],
      ["an errors limit of 0", "collectors/:collector/errors?limit=0"],
      ["an errors query it doesn't take", "collectors/:collector/errors?q=x"],
    ])("refuses %s 400 invalid_request, calling nothing", async (_label, path) => {
      const world = await aWorld();
      const url = `${fleetPath(world.organizationId, world.fleetId)}/${path.replace(":collector", world.collector.id)}`;
      expectRefusal(await send(world.admin, "GET", url), 400, "invalid_request");
      expect(calls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  describe("a configuration's fleet usage: the draft rules", () => {
    it("answers a configuration the person can see (theirs, or published), and 404 configuration_not_found for any other, calling nothing", async () => {
      const world = await aWorld();
      const contributorsDraft = await draftVersion(world.organizationId, world.contributor.userId);
      // The admin's published configuration, to the contributor; the contributor's own draft.
      expect((await send(world.contributor, "GET", usagePath(world.organizationId, world.published.configurationId))).statusCode).toBe(200);
      const own = await send(world.contributor, "GET", usagePath(world.organizationId, contributorsDraft.configurationId));
      expect(own.json()).toEqual({ usage: { configurationId: contributorsDraft.configurationId, inUse: false, publishedVersions: [] } });
      // The draft was never published: nothing to ask the opamp-server.
      expect(operations()).toEqual(["getConfigurationUsage"]);

      const deleted = await publishedVersion(world.organizationId, world.admin.userId);
      await softDelete(deleted.configurationId);
      const theirs = await team();
      const their = await publishedVersion(theirs.organizationId, theirs.admin.userId);
      calls = [];
      for (const [person, configurationId] of [
        [world.admin, contributorsDraft.configurationId],
        [world.admin, deleted.configurationId],
        [world.admin, their.configurationId],
        [world.admin, randomUUID()],
        ...MALFORMED_PATH_IDS.map((malformed) => [world.admin, malformed] as const),
      ] as const) {
        expectRefusal(await send(person, "GET", usagePath(world.organizationId, configurationId)), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      }
      expect(calls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  describe("tenancy", () => {
    it("answers another organization's fleet, group, collector and version ids 404, changing nothing of theirs", async () => {
      const mine = await aWorld();
      const theirs = await aWorld();
      const before = opamp.fake.snapshotOf(theirs.organizationId);
      const theirIds = { group: theirs.group.id, collector: theirs.collector.id };
      calls = [];

      for (const person of [mine.admin, mine.contributor]) {
        // Their fleet, under my organization.
        for (const [method, url, payload] of taskRoutes(mine.organizationId, theirs.fleetId, theirIds)) {
          expectRefusal(await send(person, method, url, payload), 404, "fleet_not_found");
        }
        // Their group and collector, under my fleet; their published version pinned here.
        const fleet = fleetPath(mine.organizationId, mine.fleetId);
        for (const [method, url, payload, code] of [
          ["GET", `${fleet}/groups/${theirs.group.id}`, undefined, "collector_group_not_found"],
          ["PATCH", `${fleet}/groups/${theirs.group.id}`, { name: "x" }, "collector_group_not_found"],
          ["PATCH", `${fleet}/groups/${theirs.group.id}`, { annotations: { telflo: { dockerMounts: [] } } }, "collector_group_not_found"],
          ["PATCH", `${fleet}/groups/${theirs.group.id}`, { annotations: null }, "collector_group_not_found"],
          ["DELETE", `${fleet}/groups/${theirs.group.id}`, undefined, "collector_group_not_found"],
          ["GET", `${fleet}/collectors/${theirs.collector.id}`, undefined, "collector_not_found"],
          ["PATCH", `${fleet}/collectors/${theirs.collector.id}`, { name: "x" }, "collector_not_found"],
          ["DELETE", `${fleet}/collectors/${theirs.collector.id}`, undefined, "collector_not_found"],
          ["GET", `${fleet}/collectors/${theirs.collector.id}/errors`, undefined, "collector_not_found"],
          ["PATCH", `${fleet}/collectors/${mine.collector.id}`, { groupId: theirs.group.id }, "collector_group_not_found"],
          ["PATCH", `${fleet}/collectors/${mine.collector.id}`, { pin: { kind: "version", versionId: theirs.published.versionId } }, "configuration_version_not_found"],
          ["POST", `${fleet}/collectors/pin`, { collectorIds: [mine.collector.id], pin: { kind: "version", versionId: theirs.published.versionId } }, "configuration_version_not_found"],
          ["GET", usagePath(mine.organizationId, theirs.published.configurationId), undefined, "configuration_not_found"],
        ] as const) {
          expectRefusal(await send(person, method, url, payload), 404, code);
        }
        // Their collectors in a bulk pin: not mine, so not found, and not pinned.
        const bulk = await send(person, "POST", `${fleet}/collectors/pin`, { collectorIds: [theirs.collector.id], pin: null });
        expect(bulk.json()).toEqual({ updated: [], notFound: [theirs.collector.id] });
        // Their published version, assigned or pinned here.
        expectRefusal(
          await send(person, "POST", `${fleet}/groups`, { name: "x", assignedVersionId: theirs.published.versionId }),
          404,
          "configuration_version_not_found",
        );
      }
      expect(opamp.fake.snapshotOf(theirs.organizationId)).toEqual(before);
      expect(await auditActions(theirs.organizationId)).toEqual(["fleet.created"]);
      // Every call named my organization.
      expect(calls.every((call) => call.args[0] === mine.organizationId)).toBe(true);
    });

    // The fleet's type is read under the session's organization, so another organization's
    // Kubernetes fleet answers as any fleet it doesn't hold, never with its type's refusals.
    it("answers another organization's Kubernetes fleet and group 404 for a rename or a settings write, with or without the settings, never its type's 409 or 400, changing nothing of theirs", async () => {
      const mine = await team();
      const theirs = await team();
      const kubernetes = (role: string) => ({ annotations: { telflo: { kubernetes: { role, namespace: "telemetry", volumes: [] } } } });
      const myFleet = await created(mine.admin, mine.organizationId, "kubernetes-supervisor");
      const theirFleet = await created(theirs.admin, theirs.organizationId, "kubernetes-supervisor");
      const theirGateway = await groupIn(theirs.admin, theirs.organizationId, theirFleet.fleetId, { name: "traces", ...kubernetes("gateway") });
      const before = opamp.fake.snapshotOf(theirs.organizationId);
      calls = [];

      for (const person of [mine.admin, mine.contributor]) {
        // Their fleet, under my organization.
        const theirGroups = `${fleetPath(mine.organizationId, theirFleet.fleetId)}/groups`;
        for (const [method, url, payload] of [
          ["PATCH", `${theirGroups}/${theirGateway.id}`, { name: "renamed" }],
          ["PATCH", `${theirGroups}/${theirGateway.id}`, kubernetes("gateway")],
          ["PATCH", `${theirGroups}/${theirFleet.defaultGroupId}`, kubernetes("node")],
          ["PATCH", `${theirGroups}/${theirGateway.id}`, { annotations: { telflo: { dockerMounts: [] } } }],
          ["POST", theirGroups, { name: "node", ...kubernetes("gateway") }],
          ["POST", theirGroups, { name: "spans", ...kubernetes("cluster") }],
          ["POST", theirGroups, { name: "spans", ...kubernetes("gateway") }],
          // Without the Kubernetes settings: a fleet it doesn't hold, never the settings' 400.
          ["POST", theirGroups, { name: "spans" }],
          ["POST", theirGroups, { name: "cluster", annotations: { acme: 1 } }],
          ["PATCH", `${theirGroups}/${theirGateway.id}`, { annotations: { acme: 1 } }],
          ["PATCH", `${theirGroups}/${theirFleet.defaultGroupId}`, { annotations: null }],
        ] as const) {
          expectRefusal(await send(person, method, url, payload), 404, "fleet_not_found", MESSAGES.fleetNotFound);
        }
        // Their group, under my Kubernetes fleet: a settings write reads the group under my fleet.
        const myGroups = `${fleetPath(mine.organizationId, myFleet.fleetId)}/groups`;
        expectRefusal(await send(person, "PATCH", `${myGroups}/${theirGateway.id}`, kubernetes("gateway")), 404, "collector_group_not_found");
        expectRefusal(await send(person, "DELETE", `${myGroups}/${theirGateway.id}`), 404, "collector_group_not_found");
      }
      expect(opamp.fake.snapshotOf(theirs.organizationId)).toEqual(before);
      // Every call named my organization.
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.args[0] === mine.organizationId)).toBe(true);
    });

    it("refuses the person's own published version in another of their organizations 404 configuration_version_not_found, calling nothing", async () => {
      const world = await aWorld();
      // The admin belongs to another organization too, and published a configuration of their own there.
      const { organization: other } = await addMembership(ownerDb, { userId: world.admin.userId });
      const theirs = await publishedVersion(other.id, world.admin.userId);
      const before = opamp.fake.snapshotOf(world.organizationId);
      calls = [];
      const fleet = fleetPath(world.organizationId, world.fleetId);
      for (const [method, url, payload] of [
        ["POST", `${fleet}/groups`, { name: "elsewhere", assignedVersionId: theirs.versionId }],
        ["PATCH", `${fleet}/groups/${world.group.id}`, { assignedVersionId: theirs.versionId }],
        ["PATCH", `${fleet}/collectors/${world.collector.id}`, { pin: { kind: "version", versionId: theirs.versionId } }],
        ["POST", `${fleet}/collectors/pin`, { collectorIds: [world.collector.id], pin: { kind: "version", versionId: theirs.versionId } }],
      ] as const) {
        expectRefusal(await send(world.admin, method, url, payload), 404, "configuration_version_not_found", MESSAGES.versionNotFound);
      }
      expect(calls).toEqual([]);
      expect(opamp.fake.snapshotOf(world.organizationId)).toEqual(before);
    });

    it("never names another organization's version beside a publication id, even one the person wrote there (crafted replies)", async () => {
      const world = await aWorld();
      const { organization: other } = await addMembership(ownerDb, { userId: world.admin.userId });
      const theirName = `OTHER-ORGANIZATION-${randomUUID()}`;
      const theirs = await publishedVersion(other.id, world.admin.userId, { name: theirName, label: "THEIR-LABEL" });
      const fleet = fleetPath(world.organizationId, world.fleetId);
      // The opamp-server never answers another organization's publication: the replies are crafted.
      hooks.getCollectorGroup = async (...args: unknown[]) => {
        const real = await opamp.client.getCollectorGroup(...(args as Parameters<OpampServerClient["getCollectorGroup"]>));
        if (real.kind !== "found") throw new Error(`the group wasn't found: ${real.kind}`);
        return { ...real, group: { ...real.group, assignedPublicationId: theirs.publicationId } };
      };
      hooks.getCollectorInstance = async (...args: unknown[]) => {
        const real = await opamp.client.getCollectorInstance(...(args as Parameters<OpampServerClient["getCollectorInstance"]>));
        if (real.kind !== "found") throw new Error(`the collector wasn't found: ${real.kind}`);
        return {
          ...real,
          collector: {
            ...real.collector,
            pin: { kind: "publication", id: theirs.publicationId },
            resolution: { from: "pinnedPublication", id: theirs.publicationId, sha256: "a".repeat(64) },
          },
        };
      };
      hooks.getConfigurationUsage = async () => ({
        kind: "found",
        usage: {
          configurationId: world.published.configurationId,
          inUse: true,
          publications: [
            { id: theirs.publicationId, version: { id: theirs.versionId, number: 3, label: null }, publishedAt: clock.toISOString(), groups: [], pinnedCollectors: 1 },
          ],
        },
      });

      const group = await send(world.admin, "GET", `${fleet}/groups/${world.group.id}`);
      expect(group.statusCode).toBe(200);
      expect(group.json<{ group: GroupBody }>().group).toMatchObject({ assignedPublishedVersionId: theirs.publicationId, assignedVersion: null });
      const collector = await send(world.admin, "GET", `${fleet}/collectors/${world.collector.id}`);
      expect(collector.statusCode).toBe(200);
      expect(collector.json<{ collector: CollectorBody }>().collector).toMatchObject({
        pin: { kind: "version", versionId: null, publishedVersionId: theirs.publicationId, version: null },
        resolution: { from: "pinnedVersion", publishedVersionId: theirs.publicationId, version: null },
      });
      const usage = await send(world.admin, "GET", usagePath(world.organizationId, world.published.configurationId));
      expect(usage.statusCode).toBe(200);
      expect(usage.json<{ usage: { publishedVersions: { publishedVersionId: string; version: unknown }[] } }>().usage.publishedVersions).toEqual([
        expect.objectContaining({ publishedVersionId: theirs.publicationId, version: null, recorded: { number: 3, label: null } }),
      ]);
      for (const reply of [group, collector, usage]) {
        expect(reply.body).not.toContain(theirName);
        expect(reply.body).not.toContain("THEIR-LABEL");
        expect(reply.body).not.toContain(theirs.versionId);
        expect(reply.body).not.toContain(theirs.configurationId);
      }
    });

    it("answers a path naming another organization 404 organization_not_found on every route, calling nothing", async () => {
      const mine = await team();
      const theirs = await aWorld();
      const before = opamp.fake.snapshotOf(theirs.organizationId);
      for (const [method, url, payload] of worldRoutes(theirs)) {
        expectRefusal(await send(mine.admin, method, url, payload), 404, "organization_not_found", MESSAGES.organizationNotFound);
      }
      expect(calls).toEqual([]);
      expect(opamp.fake.snapshotOf(theirs.organizationId)).toEqual(before);
    });

    it("answers a non-member 404 organization_not_found on every route, calling nothing", async () => {
      const world = await aWorld();
      const account = await verifiedUser();
      const outsider = { access: await signedIn(server, account.user.email) };
      for (const [method, url, payload] of worldRoutes(world)) {
        expectRefusal(await send(outsider, method, url, payload), 404, "organization_not_found");
      }
      expect(calls).toEqual([]);
    });

    it("answers a malformed fleet, group or collector id its own 404, calling nothing", async () => {
      const world = await aWorld();
      for (const malformed of MALFORMED_PATH_IDS) {
        const ids = { group: world.group.id, collector: world.collector.id };
        for (const [method, url, payload] of taskRoutes(world.organizationId, malformed, ids)) {
          expectRefusal(await send(world.admin, method, url, payload), 404, "fleet_not_found");
        }
        const fleet = fleetPath(world.organizationId, world.fleetId);
        for (const [method, url, payload, code] of [
          ["GET", `${fleet}/groups/${malformed}`, undefined, "collector_group_not_found"],
          ["PATCH", `${fleet}/groups/${malformed}`, { name: "x" }, "collector_group_not_found"],
          ["DELETE", `${fleet}/groups/${malformed}`, undefined, "collector_group_not_found"],
          ["GET", `${fleet}/collectors/${malformed}`, undefined, "collector_not_found"],
          ["PATCH", `${fleet}/collectors/${malformed}`, { name: "x" }, "collector_not_found"],
          ["DELETE", `${fleet}/collectors/${malformed}`, undefined, "collector_not_found"],
          ["GET", `${fleet}/collectors/${malformed}/errors`, undefined, "collector_not_found"],
        ] as const) {
          expectRefusal(await send(world.admin, method, url, payload), 404, code);
        }
      }
      expect(calls).toEqual([]);
    });

    it("answers the imports routes, which don't exist, 404 not_found, calling nothing", async () => {
      const world = await aWorld();
      const fleet = fleetPath(world.organizationId, world.fleetId);
      for (const url of [`${fleet}/imports`, `${fleet}/imports/${randomUUID()}`]) {
        expectRefusal(await send(world.admin, "GET", url), 404, "not_found");
      }
      expect(calls).toEqual([]);
    });

    it("refuses a person who hasn't accepted the current terms 403 on every route, and a signed-out request 401, calling nothing", async () => {
      const account = await verifiedUser({ user: { accepted_terms_version: "2025-01-01" } });
      const person = { access: await signedIn(server, account.user.email) };
      const id = randomUUID();
      const routes = [
        ...taskRoutes(account.organization.id, id, { group: id, collector: id }),
        ["GET", usagePath(account.organization.id, id), undefined, "getConfigurationUsage"],
      ] as const;
      for (const [method, url, payload] of routes) {
        expectRefusal(await send(person, method, url, payload), 403, "terms_acceptance_required", MESSAGES.terms);
        expectRefusal(await send(undefined, method, url, payload), 401, "unauthenticated");
      }
      expect(calls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  describe("the one 503", () => {
    const FAULTS = ["error_500", "hang", "reset", "malformed_reply", "oversized"] as const;
    const OPERATIONS = [
      "listCollectorGroups",
      "createCollectorGroup",
      "getCollectorGroup",
      "updateCollectorGroup",
      "deleteCollectorGroup",
      "listCollectorInstances",
      "pinCollectorInstances",
      "getCollectorInstance",
      "updateCollectorInstance",
      "deleteCollectorInstance",
      "listCollectorInstanceErrors",
      "getConfigurationUsage",
    ] as const;

    /** A client of the fake that gives up fast (a hang) or reads nothing (an oversized reply). */
    const faultyClient = (fault: (typeof FAULTS)[number]) =>
      createOpampServerClient({
        url: opamp.fake.url,
        secret: opamp.fake.secret,
        ...(fault === "hang" ? { timeoutMs: 200 } : {}),
        ...(fault === "oversized" ? { maxReplyBytes: { S: 8, M: 8, U: 8, L: 8 } } : {}),
      });

    describe.each(OPERATIONS)("%s", (operation) => {
      it.each(FAULTS)("answers %s 503 fleets_unavailable with the general message, logging ids and the kind only", async (fault) => {
        const world = await aWorld();
        const name = `CANARY-NAME-${randomUUID()}`;
        if (fault === "oversized" && (operation === "deleteCollectorGroup" || operation === "deleteCollectorInstance")) {
          // A 204 has no body to be over any cap: the client's answer to an oversized one, injected.
          hooks[operation] = async () => ({ kind: "unavailable", reason: "oversized_reply" });
        } else if (fault === "hang" || fault === "oversized") {
          const client = faultyClient(fault);
          hooks[operation] = (...args: unknown[]) => (client[operation] as unknown as (...given: unknown[]) => Promise<unknown>)(...args);
        }
        if (fault !== "oversized") opamp.fake.nextFault(fault as FakeOpampServerFault, operation);

        const [method, url, payload] = worldRoutes(world).find(([, , , op]) => op === operation) as readonly [Method, string, Record<string, unknown> | undefined, string];
        const body = payload === undefined ? undefined : "name" in payload ? { ...payload, name } : payload;
        const response = await send(world.admin, method, url, body);

        expectRefusal(response, 503, "fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE);
        if (fault === "malformed_reply") expect(opamp.fake.takeViolations()).toHaveLength(1);
        const line = logged().find((entry) => entry.operation === operation);
        expect(line).toMatchObject({ operation, organizationId: world.organizationId });
        if (operation !== "getConfigurationUsage") expect(line).toMatchObject({ fleetId: world.fleetId });
        if (fault === "malformed_reply") expect(line).toMatchObject({ level: 50, error: expect.stringContaining(operation) });
        else expect(line).toMatchObject({ level: 40, result: "unavailable" });
        expectNotLogged(opamp.fake.url, opamp.fake.secret, "127.0.0.1:", name, world.group.name, world.collector.name, world.published.configurationName);
      });
    });

    it("answers a 413 and an undocumented answer 503", async () => {
      const world = await aWorld();
      hooks.updateCollectorInstance = async () => ({ kind: "invalid", code: "payload_too_large" });
      expectRefusal(
        await send(world.admin, "PATCH", `${fleetPath(world.organizationId, world.fleetId)}/collectors/${world.collector.id}`, { name: "x" }),
        503,
        "fleets_unavailable",
      );
      // A 400 the platform's own checks should have prevented: not the person's to fix.
      hooks.createCollectorGroup = async () => ({ kind: "invalid", code: "invalid_request" });
      expectRefusal(await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/groups`, { name: "x" }), 503, "fleets_unavailable");
      expect(logged().find((line) => line.operation === "createCollectorGroup")).toMatchObject({ level: 50, result: "invalid", code: "invalid_request" });
      expectNotLogged("annotations must be");
    });
  });

  // -------------------------------------------------------------------------

  describe("the person's limits", () => {
    let limited: FastifyInstance;

    beforeAll(async () => {
      limited = build({
        ...TEST_RATE_LIMITS,
        fleetReadsPerUser: { max: 3, windowMs: 60_000 },
        fleetWritesPerUser: { max: 2, windowMs: 60_000 },
      });
      await limited.ready();
    });

    afterAll(async () => {
      await limited.close();
    });

    const expectLimited = (response: LightMyRequestResponse) => {
      expectRefusal(response, 429, "rate_limited", MESSAGES.rateLimited);
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    };

    it("counts every GET a read, the fleet usage's included, and answers past them 429 with Retry-After, calling nothing", async () => {
      const world = await aWorld(limited);
      const fleet = fleetPath(world.organizationId, world.fleetId);
      // The world's group create spent a write; no read yet.
      expect((await send(world.admin, "GET", `${fleet}/collectors`, undefined, limited)).statusCode).toBe(200);
      expect((await send(world.admin, "GET", `${fleet}/collectors/${world.collector.id}`, undefined, limited)).statusCode).toBe(200);
      expect((await send(world.admin, "GET", usagePath(world.organizationId, world.published.configurationId), undefined, limited)).statusCode).toBe(200);
      calls = [];
      for (const [method, url] of worldRoutes(world).filter(([method]) => method === "GET")) {
        expectLimited(await send(world.admin, method, url, undefined, limited));
      }
      expect(calls).toEqual([]);
      // Another member's reads are their own.
      expect((await send(world.contributor, "GET", `${fleet}/groups`, undefined, limited)).statusCode).toBe(200);
    });

    it("counts every other route a write: a group's, a collector's, a pin; refusals before a call spend nothing", async () => {
      const world = await aWorld(limited);
      const fleet = fleetPath(world.organizationId, world.fleetId);
      // Refused before the limit: a draft's version, a malformed id.
      const draft = await draftVersion(world.organizationId, world.admin.userId);
      expectRefusal(await send(world.admin, "POST", `${fleet}/collectors/pin`, { collectorIds: [world.collector.id], pin: { kind: "version", versionId: draft.versionId } }, limited), 422, "configuration_version_not_published");
      expectRefusal(await send(world.admin, "DELETE", `${fleet}/collectors/42`, undefined, limited), 404, "collector_not_found");
      // The world's group create spent one write: one left.
      expect((await send(world.admin, "POST", `${fleet}/collectors/pin`, { collectorIds: [world.collector.id], pin: null }, limited)).statusCode).toBe(200);
      calls = [];
      for (const [method, url, payload] of worldRoutes(world).filter(([method]) => method !== "GET")) {
        expectLimited(await send(world.admin, method, url, payload, limited));
      }
      expect(calls).toEqual([]);
      expect((await send(world.contributor, "PATCH", `${fleet}/groups/${world.group.id}`, { name: "renamed" }, limited)).statusCode).toBe(200);
    });

    it("answers a never-published configuration's usage empty, calling nothing and spending no read", async () => {
      const world = await aWorld(limited);
      const fleet = fleetPath(world.organizationId, world.fleetId);
      const draft = await draftVersion(world.organizationId, world.admin.userId);
      const bare = await addConfiguration(ownerDb, { organizationId: world.organizationId, created_by_user_id: world.admin.userId });
      // Every read spent.
      for (let read = 0; read < 3; read++) expect((await send(world.admin, "GET", `${fleet}/groups`, undefined, limited)).statusCode).toBe(200);
      expectLimited(await send(world.admin, "GET", usagePath(world.organizationId, world.published.configurationId), undefined, limited));
      calls = [];
      for (const configurationId of [draft.configurationId, bare.id]) {
        const usage = await send(world.admin, "GET", usagePath(world.organizationId, configurationId), undefined, limited);
        expect(usage.statusCode).toBe(200);
        expect(usage.json()).toEqual({ usage: { configurationId, inUse: false, publishedVersions: [] } });
      }
      expect(calls).toEqual([]);
    });

    it("gives a request's slot back however a group's or a collector's request fails, twice over; then 16 are held and the 17th is 429", async () => {
      const world = await aWorld();
      const fleet = fleetPath(world.organizationId, world.fleetId);
      const second = opamp.fake.enrollCollector(world.organizationId, world.fleetId, { name: `second-${randomUUID()}` });
      // The fleet's type read before a group's create fails its own way for each of these fleets.
      const preRead = { unavailable: randomUUID(), throws: randomUUID(), misconfigured: randomUUID() };
      let failing = createGate();
      let held = 0;
      let heldAll!: () => void;
      let allHeld = Promise.resolve();
      const holding = <Result>(fail: (...args: unknown[]) => Promise<Result>) => async (...args: unknown[]) => {
        if (++held === FAILING.length) heldAll();
        await failing.hold();
        return fail(...args);
      };
      hooks.getFleet = holding(async (...args) => {
        const [, fleetId] = args as Parameters<OpampServerClient["getFleet"]>;
        if (fleetId === preRead.unavailable) return { kind: "unavailable", reason: "timeout" };
        if (fleetId === preRead.throws) throw new Error("a plain failure");
        if (fleetId === preRead.misconfigured) throw new OpampServerMisconfigurationError("The opamp-server's reply to getFleet (200) isn't the API's.");
        return opamp.client.getFleet(...(args as Parameters<OpampServerClient["getFleet"]>));
      });
      hooks.updateCollectorGroup = holding(async () => ({ kind: "publication_not_found" }));
      hooks.createCollectorGroup = holding((...args) => opamp.client.createCollectorGroup(...(args as Parameters<OpampServerClient["createCollectorGroup"]>)));
      hooks.updateCollectorInstance = holding((...args) => opamp.client.updateCollectorInstance(...(args as Parameters<OpampServerClient["updateCollectorInstance"]>)));
      hooks.deleteCollectorInstance = holding(async () => {
        throw new Error("a plain failure");
      });
      hooks.getCollectorInstance = holding(async () => {
        throw new OpampServerMisconfigurationError("The opamp-server's reply to getCollectorInstance (200) isn't the API's.");
      });
      const kubernetes = (fleetId: string) => () =>
        send(world.admin, "POST", `${fleetPath(world.organizationId, fleetId)}/groups`, {
          name: "k8s",
          annotations: { telflo: { kubernetes: { role: "gateway", namespace: "telemetry", volumes: [] } } },
        });
      const FAILING = [
        // The pre-read: a server fleet's (400), an unknown fleet (404), down (503), a throw (503), a misconfiguration (503).
        [kubernetes(world.fleetId), 400, "invalid_request"],
        [kubernetes(randomUUID()), 404, "fleet_not_found"],
        [kubernetes(preRead.unavailable), 503, "fleets_unavailable"],
        [kubernetes(preRead.throws), 503, "fleets_unavailable"],
        [kubernetes(preRead.misconfigured), 503, "fleets_unavailable"],
        // The two sides disagreeing about a resolved version (503), a group's name taken (409), a collector's name taken (409).
        [() => send(world.admin, "PATCH", `${fleet}/groups/${world.group.id}`, { assignedVersionId: world.published.versionId }), 503, "fleets_unavailable"],
        [() => send(world.admin, "POST", `${fleet}/groups`, { name: world.group.name }), 409, "collector_group_name_taken"],
        [() => send(world.admin, "PATCH", `${fleet}/collectors/${world.collector.id}`, { name: second.name }), 409, "collector_name_taken"],
        // A plain throw and a misconfiguration (each 503).
        [() => send(world.admin, "DELETE", `${fleet}/collectors/${world.collector.id}`), 503, "fleets_unavailable"],
        [() => send(world.admin, "GET", `${fleet}/collectors/${world.collector.id}`), 503, "fleets_unavailable"],
      ] as const;

      // Two rounds of 10 at once: the second fits only if the first gave all its slots back.
      for (let round = 0; round < 2; round++) {
        failing = createGate();
        held = 0;
        allHeld = new Promise<void>((resolve) => (heldAll = resolve));
        const failures = FAILING.map(([request, status, code]) => ({ response: request(), status, code }));
        // Any answer before all are held is a refusal (a slot short): it ends the wait instead of hanging it.
        try {
          await Promise.race([allHeld, ...failures.map(({ response }) => response)]);
          expect(held, `round ${round + 1}`).toBe(FAILING.length);
        } finally {
          failing.release();
        }
        const answers = await Promise.all(failures.map(({ response }) => response));
        expect(answers.map((response) => [response.statusCode, response.json<{ error: { code: string } }>().error.code])).toEqual(
          failures.map(({ status, code }) => [status, code]),
        );
      }

      // Every slot came back, and none twice: 16 are held, the 17th is refused.
      hooks = {};
      const gate = createGate();
      let reading = 0;
      let readAll!: () => void;
      const sixteenHeld = new Promise<void>((resolve) => (readAll = resolve));
      hooks.listCollectorGroups = async (...args: unknown[]) => {
        if (++reading === 16) readAll();
        await gate.hold();
        return opamp.client.listCollectorGroups(...(args as Parameters<OpampServerClient["listCollectorGroups"]>));
      };
      const reads = Array.from({ length: 16 }, () => send(world.admin, "GET", `${fleet}/groups`));
      try {
        await Promise.race([sixteenHeld, ...reads]);
        expect(reading).toBe(16);
        calls = [];
        expectRefusal(await send(world.admin, "GET", `${fleet}/collectors`), 429, "rate_limited");
        expect(calls).toEqual([]);
      } finally {
        gate.release();
      }
      expect((await Promise.all(reads)).map((response) => response.statusCode)).toEqual(Array(16).fill(200));
    });
  });

  // -------------------------------------------------------------------------

  describe("variable bindings: a group's variable group and a collector's", () => {
    const ref = (name: string) => "${org:" + name + "}";
    const uniqueName = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").toUpperCase()}`;

    /** A variable group of the organization, made in the opamp-server as the variables routes would. */
    const aVariableGroup = async (organizationId: string) => {
      await registered(organizationId);
      const result = await opamp.client.createVariableGroup(organizationId, { id: randomUUID(), name: `vg-${randomUUID()}`, description: null, actor: null });
      if (result.kind !== "created") throw new Error(`the fake's createVariableGroup answered ${result.kind}`);
      return result.variableGroup.id;
    };

    /** A variable of the organization's. */
    const aVariable = async (organizationId: string, name: string) => {
      await registered(organizationId);
      const result = await opamp.client.createVariable(organizationId, { id: randomUUID(), name, value: "v", description: null, actor: null });
      expect(result.kind).toBe("created");
    };

    /** A published version of the admin's whose text (the opamp-server's copy) references `names`. */
    const publishedReferencing = async (organizationId: string, creatorUserId: string, names: readonly string[]) => {
      const configuration = await addConfiguration(ownerDb, { organizationId, created_by_user_id: creatorUserId });
      const yaml = `exporters:\n${names.map((name, index) => `  e${index}: ${ref(name)}\n`).join("")}`;
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        created_by_user_id: creatorUserId,
        yaml_content: yaml,
        publishedAt: new Date(),
        publishedByUserId: creatorUserId,
      });
      await registered(organizationId);
      const put = await opamp.client.postPublication(organizationId, version.publication_id as string, {
        configuration: { id: configuration.id, name: configuration.name },
        version: { id: version.id, number: version.version_number, label: null },
        yaml,
        sha256: sha256Hex(yaml),
        publishedBy: null,
        publishedAt: clock.toISOString(),
        collector: await catalogueDefaults(ownerDb),
      });
      expect(put.kind).toBe("created");
      return version.id;
    };

    const collectorOf = (body: LightMyRequestResponse) => body.json<{ collector: CollectorBody & { pinnedVariableGroupId: string | null } }>().collector;

    it("round-trips a group's variableGroupId on its create and update, and a collector's pinnedVariableGroupId on its update and the bulk pin, each absent field left as it is", async () => {
      const world = await aWorld();
      const variableGroupId = await aVariableGroup(world.organizationId);
      const other = await aVariableGroup(world.organizationId);
      const fleet = fleetPath(world.organizationId, world.fleetId);

      const created = await send(world.contributor, "POST", `${fleet}/groups`, { name: "with-vg", variableGroupId: variableGroupId.toUpperCase() });
      expect(created.statusCode).toBe(201);
      const groupId = created.json<{ group: GroupBody & { variableGroupId: string | null } }>().group.id;
      expect(created.json<{ group: { variableGroupId: string | null } }>().group.variableGroupId).toBe(variableGroupId);
      expect((await send(world.admin, "GET", `${fleet}/groups/${groupId}`)).json<{ group: { variableGroupId: string | null } }>().group.variableGroupId).toBe(variableGroupId);
      for (const next of [null, other, variableGroupId]) {
        const updated = await send(world.contributor, "PATCH", `${fleet}/groups/${groupId}`, { variableGroupId: next });
        expect(updated.statusCode).toBe(200);
        expect(updated.json<{ group: { variableGroupId: string | null } }>().group.variableGroupId).toBe(next);
      }
      // A rename leaves it as it is.
      const renamed = await send(world.admin, "PATCH", `${fleet}/groups/${groupId}`, { name: "renamed-vg" });
      expect(renamed.json<{ group: { variableGroupId: string | null } }>().group.variableGroupId).toBe(variableGroupId);
      expect(calls.filter((call) => call.operation === "updateCollectorGroup").at(-1)?.args[3]).toEqual({ name: "renamed-vg" });

      const collectorPath = `${fleet}/collectors/${world.collector.id}`;
      const pinned = await send(world.contributor, "PATCH", collectorPath, { pinnedVariableGroupId: variableGroupId });
      expect(pinned.statusCode).toBe(200);
      expect(collectorOf(pinned)).toMatchObject({ pin: null, pinnedVariableGroupId: variableGroupId });
      expect(collectorOf(await send(world.contributor, "PATCH", collectorPath, { pinnedVariableGroupId: null }))).toMatchObject({ pinnedVariableGroupId: null });

      // The bulk pin: the variable group alone leaves the pin as it is; the pin alone leaves the variable group.
      const bulk = (payload: Record<string, unknown>) => send(world.admin, "POST", `${fleet}/collectors/pin`, { collectorIds: [world.collector.id], ...payload });
      const byVariableGroup = await bulk({ pinnedVariableGroupId: other });
      expect(byVariableGroup.json()).toEqual({ updated: [world.collector.id], notFound: [] });
      expect(calls.filter((call) => call.operation === "pinCollectorInstances").at(-1)?.args[2]).toEqual({ collectorIds: [world.collector.id], pinnedVariableGroupId: other });
      expect(collectorOf(await send(world.admin, "GET", collectorPath))).toMatchObject({ pin: null, pinnedVariableGroupId: other });
      expect((await bulk({ pin: { kind: "version", versionId: world.published.versionId } })).statusCode).toBe(200);
      expect(calls.filter((call) => call.operation === "pinCollectorInstances").at(-1)?.args[2]).toEqual({
        collectorIds: [world.collector.id],
        pin: { kind: "publication", id: world.published.publicationId },
      });
      expect(collectorOf(await send(world.admin, "GET", collectorPath))).toMatchObject({ pin: { publishedVersionId: world.published.publicationId }, pinnedVariableGroupId: other });
      expect((await bulk({ pin: null, pinnedVariableGroupId: null })).statusCode).toBe(200);
      expect(collectorOf(await send(world.admin, "GET", collectorPath))).toMatchObject({ pin: null, pinnedVariableGroupId: null });
      // Neither: the contract's 400, no call.
      calls = [];
      expect((await bulk({})).statusCode).toBe(400);
      expect(operations()).toEqual([]);
      // A binding's change is unaudited.
      expect(await auditActions(world.organizationId)).toEqual(["fleet.created"]);
    });

    it("answers a variable group the organization doesn't hold (unknown, or another organization's) 404 variable_group_not_found on each binding, changing nothing", async () => {
      const world = await aWorld();
      const theirs = await aWorld();
      const theirVariableGroup = await aVariableGroup(theirs.organizationId);
      await registered(world.organizationId);
      const fleet = fleetPath(world.organizationId, world.fleetId);
      const before = opamp.fake.snapshotOf(world.organizationId);
      const theirsBefore = opamp.fake.snapshotOf(theirs.organizationId);
      for (const variableGroupId of [randomUUID(), theirVariableGroup]) {
        for (const [method, url, payload] of [
          ["POST", `${fleet}/groups`, { name: "bound", variableGroupId }],
          ["PATCH", `${fleet}/groups/${world.group.id}`, { variableGroupId }],
          ["PATCH", `${fleet}/collectors/${world.collector.id}`, { pinnedVariableGroupId: variableGroupId }],
          ["POST", `${fleet}/collectors/pin`, { collectorIds: [world.collector.id], pinnedVariableGroupId: variableGroupId }],
        ] as const) {
          expectRefusal(await send(world.contributor, method, url, payload), 404, "variable_group_not_found", "Variable group not found");
        }
      }
      expect(opamp.fake.snapshotOf(world.organizationId)).toEqual(before);
      expect(opamp.fake.snapshotOf(theirs.organizationId)).toEqual(theirsBefore);
    });

    it("answers an assignment or a pin of a version referencing undefined variables 422 variables_undefined with their names and total, never logged", async () => {
      const world = await aWorld();
      const defined = uniqueName("DEFINED");
      const missing = [uniqueName("MISSING_B"), uniqueName("MISSING_A")];
      await aVariable(world.organizationId, defined);
      const versionId = await publishedReferencing(world.organizationId, world.admin.userId, [defined, ...missing]);
      const fleet = fleetPath(world.organizationId, world.fleetId);
      const before = opamp.fake.snapshotOf(world.organizationId);
      const expected = { names: [...missing].sort(), totalNames: 2 };
      for (const [method, url, payload] of [
        ["POST", `${fleet}/groups`, { name: "assigned", assignedVersionId: versionId }],
        ["PATCH", `${fleet}/groups/${world.group.id}`, { assignedVersionId: versionId }],
        ["PATCH", `${fleet}/collectors/${world.collector.id}`, { pin: { kind: "version", versionId } }],
        ["POST", `${fleet}/collectors/pin`, { collectorIds: [world.collector.id], pin: { kind: "version", versionId } }],
      ] as const) {
        const response = await send(world.contributor, method, url, payload);
        expectRefusal(response, 422, "variables_undefined", "The published version references organization variables that aren't defined: define them first.");
        expect(response.json<{ error: { details: unknown } }>().error.details).toEqual(expected);
      }
      expect(opamp.fake.snapshotOf(world.organizationId)).toEqual(before);
      expectNotLogged(defined, ...missing);
      // Defined, they assign.
      for (const name of missing) await aVariable(world.organizationId, name);
      expect((await send(world.contributor, "PATCH", `${fleet}/groups/${world.group.id}`, { assignedVersionId: versionId })).statusCode).toBe(200);
    });
  });

  describe("privacy", () => {
    it("logs no attribute, error text, group or collector name, and writes none into an audit row or an error answer (canaries)", async () => {
      const world = await aWorld();
      const canary = (what: string) => `CANARY-${what}-${randomUUID()}`;
      const attribute = canary("ATTRIBUTE");
      const errorText = canary("ERROR");
      const effectiveError = canary("EFFECTIVE");
      const groupName = canary("GROUP");
      const collectorName = canary("COLLECTOR");
      const renamed = canary("RENAMED");
      const fleet = fleetPath(world.organizationId, world.fleetId);

      const collector = opamp.fake.enrollCollector(world.organizationId, world.fleetId, {
        name: collectorName,
        reported: { attributes: { "host.name": attribute } },
      });
      opamp.fake.recordCollectorError(world.organizationId, collector.id, { message: errorText });
      opamp.fake.setCollectorState(world.organizationId, collector.id, {
        effective: { sha256: "a".repeat(64), status: "failed", error: effectiveError },
      });

      const answers = [
        await send(world.admin, "POST", `${fleet}/groups`, { name: groupName }),
        await send(world.admin, "GET", `${fleet}/groups`),
        await send(world.admin, "GET", `${fleet}/collectors?q=${encodeURIComponent(collectorName)}`),
        await send(world.admin, "GET", `${fleet}/collectors/${collector.id}`),
        await send(world.admin, "GET", `${fleet}/collectors/${collector.id}/errors`),
        await send(world.admin, "PATCH", `${fleet}/collectors/${collector.id}`, { name: renamed }),
      ];
      expect(answers.map((answer) => answer.statusCode)).toEqual([201, 200, 200, 200, 200, 200]);
      // Each reaches its reply.
      for (const [index, value] of [[1, groupName], [2, collectorName], [3, attribute], [3, effectiveError], [4, errorText], [5, renamed]] as const) {
        expect(answers[index]?.body).toContain(value);
      }
      // Refusals echo none of them.
      const refusals = [
        await send(world.admin, "POST", `${fleet}/groups`, { name: groupName }),
        await send(world.admin, "POST", `${fleet}/groups`, { name: ` ${groupName}` }),
        await send(world.admin, "PATCH", `${fleet}/collectors/${world.collector.id}`, { name: renamed }),
        await send(world.admin, "PATCH", `${fleet}/collectors/${world.collector.id}`, { name: `${renamed}\u0007` }),
      ];
      expect(refusals.map((answer) => answer.statusCode)).toEqual([409, 400, 409, 400]);
      // And when the opamp-server fails, nothing but ids is logged.
      for (const operation of ["getCollectorInstance", "listCollectorInstanceErrors"] as const) opamp.fake.nextFault("error_500", operation);
      await send(world.admin, "GET", `${fleet}/collectors/${collector.id}`);
      await send(world.admin, "GET", `${fleet}/collectors/${collector.id}/errors`);

      const secrets = [attribute, errorText, effectiveError, groupName, collectorName, renamed];
      expectNotLogged(...secrets);
      const audit = await auditText(world.organizationId);
      for (const secret of secrets) expect(audit).not.toContain(secret);
      for (const answer of refusals) for (const secret of secrets) expect(answer.body).not.toContain(secret);
    });

    it("logs a collector list's request without its query: the search's text and a name-sorted cursor", async () => {
      const world = await aWorld();
      const name = `CANARY-SORTED-${randomUUID()}`;
      opamp.fake.enrollCollector(world.organizationId, world.fleetId, { name: `${name}-1` });
      opamp.fake.enrollCollector(world.organizationId, world.fleetId, { name: `${name}-2` });
      const collectors = `${fleetPath(world.organizationId, world.fleetId)}/collectors`;
      const first = await send(world.admin, "GET", `${collectors}?q=CANARY-SORTED&sort=name&order=asc&limit=1`);
      const cursor = first.json<{ nextCursor: string }>().nextCursor;
      expect(cursor).toEqual(expect.any(String));
      const next = await send(world.admin, "GET", `${collectors}?q=CANARY-SORTED&sort=name&order=asc&limit=1&cursor=${encodeURIComponent(cursor)}`);
      expect(next.json<{ collectors: CollectorBody[] }>().collectors.map((c) => c.name)).toEqual([`${name}-2`]);

      const requests = logged().filter((line) => line.req !== undefined);
      expect(requests.map((line) => (line.req as { url: string }).url)).toEqual([collectors, collectors]);
      expectNotLogged("CANARY-", cursor, encodeURIComponent(cursor));
    });
  });
});
