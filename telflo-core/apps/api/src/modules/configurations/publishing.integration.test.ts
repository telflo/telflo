import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, FLEETS_UNAVAILABLE_AT_DELETE_MESSAGE } from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  createUserWithOrganization,
  truncateAll,
} from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import {
  createOpampServerClient,
  OpampServerMisconfigurationError,
  type OpampServerClient,
  type PublicationRequest,
} from "../../opamp-server/client.js";
import { FAKE_OPAMP_SERVER_SECRET, type FakeOpampServerFault } from "../../testing/fake-opamp-server.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { hashPassword } from "../identity/password.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

/** The refusals' words, exactly: the publish's own and the envelope's. */
const MESSAGES = {
  configurationNotFound: "Configuration not found",
  versionNotFound: "Version not found",
  organizationNotFound: "Organization not found",
  alreadyPublished: (number: number) => `Version ${number} is already published.`,
  changed: "This version changed while it was being published. Try again.",
  empty: "An empty version can't be published.",
  unavailable: "Publishing is unavailable right now. Try again.",
  internal: "Something went wrong. Please try again.",
  terms: "Accept the current Terms of Service to continue.",
  unauthenticated: "You need to sign in.",
  csrf: "This request is missing a required header.",
  inUse: "A collector group or a collector uses a published version of this configuration. Remove it from them first.",
  forbidden: "Only the configuration's author or an organization admin can delete it.",
  rateLimited: "Too many attempts. Please wait and try again.",
};

/** A version as the picker lists it, as a publish answers it. */
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

interface ConfigurationBody {
  id: string;
  name: string;
  published: boolean;
}

/** Ids that aren't canonical UUIDs, as a path segment carries them. */
const MALFORMED_PATH_IDS = [
  "not-a-uuid",
  "42",
  "0192F1A47B3C7D2E8F101A2B3C4D5E6F",
  "%7B0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f%7D",
];

const EMPTY_GRAPH = { nodes: [], edges: [], pipelines: [] };

/**
 * A version's text with multi-byte UTF-8 (two-, three- and four-byte
 * characters) and a trailing newline, and a marker no log line may hold.
 */
const yamlWith = (marker: string) =>
  `receivers:\n  otlp:\n    protocols:\n      grpc: {}\n# ${marker} café 日本語 🚀\nexporters:\n  debug: {}\n`;

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
 * The publish and its refusals against Postgres, through the API as its own
 * role, with the OpenAPI-checked fake as the opamp-server. The server's client
 * is the fake's, wrapped in process: every call is recorded, and a test can
 * put a hook in front of any method (a gate on `postPublication`, a fault
 * armed just before it, an answer the fake can't be pushed to give).
 */
describe("publishing a version", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  /** The server's log lines since the test began, at info and above. */
  let logLines: string[] = [];
  /** The runner a delete's clean-up is queued on: nothing runs until `settle()`. */
  let runner: CollectingRunner;
  /** Every call the server made to the opamp-server since the test began. */
  let calls: Call[] = [];
  /** A test's hooks, in front of the client's methods. */
  let hooks: Partial<OpampServerClient> = {};
  /** The client the wrapper delegates to when no hook is set: the fake's, unless a test swaps it. */
  let delegate: () => OpampServerClient = () => opamp.client;

  /** A method of the wrapper: records the call, then runs the test's hook or the delegate. */
  function recorded<Method extends keyof OpampServerClient>(operation: Method): OpampServerClient[Method] {
    return ((...args: unknown[]) => {
      calls.push({ operation, args });
      const target = (hooks[operation] ?? delegate()[operation]) as (...given: unknown[]) => unknown;
      return target(...args);
    }) as OpampServerClient[Method];
  }

  /** The wrapper the server calls. Each method records the call, then runs the test's hook or the delegate. */
  const serverClient: OpampServerClient = {
    createOrganization: (...args) => {
      calls.push({ operation: "createOrganization", args });
      return (hooks.createOrganization ?? delegate().createOrganization)(...args);
    },
    getOrganization: (...args) => {
      calls.push({ operation: "getOrganization", args });
      return (hooks.getOrganization ?? delegate().getOrganization)(...args);
    },
    renameOrganization: (...args) => {
      calls.push({ operation: "renameOrganization", args });
      return (hooks.renameOrganization ?? delegate().renameOrganization)(...args);
    },
    deleteOrganization: (...args) => {
      calls.push({ operation: "deleteOrganization", args });
      return (hooks.deleteOrganization ?? delegate().deleteOrganization)(...args);
    },
    postPublication: (...args) => {
      calls.push({ operation: "postPublication", args });
      return (hooks.postPublication ?? delegate().postPublication)(...args);
    },
    getPublication: (...args) => {
      calls.push({ operation: "getPublication", args });
      return (hooks.getPublication ?? delegate().getPublication)(...args);
    },
    listPublications: (...args) => {
      calls.push({ operation: "listPublications", args });
      return (hooks.listPublications ?? delegate().listPublications)(...args);
    },
    deletePublication: (...args) => {
      calls.push({ operation: "deletePublication", args });
      return (hooks.deletePublication ?? delegate().deletePublication)(...args);
    },
    deleteConfigurationPublications: (...args) => {
      calls.push({ operation: "deleteConfigurationPublications", args });
      return (hooks.deleteConfigurationPublications ?? delegate().deleteConfigurationPublications)(...args);
    },
    // The fleet model.
    getConfigurationUsage: recorded("getConfigurationUsage"),
    getLimits: recorded("getLimits"),
    setLimits: recorded("setLimits"),
    createFleet: recorded("createFleet"),
    listFleets: recorded("listFleets"),
    getFleet: recorded("getFleet"),
    updateFleet: recorded("updateFleet"),
    deleteFleet: recorded("deleteFleet"),
    listCollectorGroups: recorded("listCollectorGroups"),
    createCollectorGroup: recorded("createCollectorGroup"),
    getCollectorGroup: recorded("getCollectorGroup"),
    updateCollectorGroup: recorded("updateCollectorGroup"),
    deleteCollectorGroup: recorded("deleteCollectorGroup"),
    listEnrollmentTokens: recorded("listEnrollmentTokens"),
    listEnrollmentTokenEvents: recorded("listEnrollmentTokenEvents"),
    rotateEnrollmentToken: recorded("rotateEnrollmentToken"),
    issueDefaultEnrollmentToken: recorded("issueDefaultEnrollmentToken"),
    revealEnrollmentToken: recorded("revealEnrollmentToken"),
    revokeEnrollmentToken: recorded("revokeEnrollmentToken"),
    listCollectorInstances: recorded("listCollectorInstances"),
    pinCollectorInstances: recorded("pinCollectorInstances"),
    getCollectorInstance: recorded("getCollectorInstance"),
    updateCollectorInstance: recorded("updateCollectorInstance"),
    deleteCollectorInstance: recorded("deleteCollectorInstance"),
    listCollectorInstanceErrors: recorded("listCollectorInstanceErrors"),
    listVariables: recorded("listVariables"),
    createVariable: recorded("createVariable"),
    updateVariable: recorded("updateVariable"),
    deleteVariable: recorded("deleteVariable"),
    listVariableGroups: recorded("listVariableGroups"),
    createVariableGroup: recorded("createVariableGroup"),
    getVariableGroup: recorded("getVariableGroup"),
    updateVariableGroup: recorded("updateVariableGroup"),
    deleteVariableGroup: recorded("deleteVariableGroup"),
    setVariableGroupOverride: recorded("setVariableGroupOverride"),
    resetVariableGroupOverride: recorded("resetVariableGroupOverride"),
  };

  /** A server on the wrapped client, its log captured at info, with `rateLimits`. */
  function build(rateLimits: RateLimits): FastifyInstance {
    // Info, so each request's own log line is captured too.
    const previousLevel = process.env.LOG_LEVEL;
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
    // Whole milliseconds, as the API's clock always is.
    clock = new Date(Math.floor(Date.now() / 1000) * 1000);
    logLines = [];
    runner = createCollectingRunner();
    calls = [];
    hooks = {};
    delegate = () => opamp.client;
  });

  /** Moves the server's clock on. Seconds, not hours: the access tokens read the same clock. */
  const tick = (milliseconds = 1_000) => {
    clock = new Date(clock.getTime() + milliseconds);
    return clock;
  };

  const operations = () => calls.map((call) => call.operation);

  /** The publications the server put, in order: its organization, its id and its body. */
  const puts = () =>
    calls
      .filter((call) => call.operation === "postPublication")
      .map((call) => {
        const [organizationId, publicationId, publication] = call.args as [string, string, PublicationRequest];
        return { organizationId, publicationId, publication };
      });

  /** The configuration's snapshots the fake holds, newest first. */
  const snapshotsIn = async (organizationId: string, configurationId: string) => {
    const result = await opamp.client.listPublications(organizationId, { configurationId });
    if (result.kind === "organization_not_found") return [];
    if (result.kind !== "page") throw new Error(`the fake's list answered ${result.kind}`);
    return result.page.publications;
  };

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message: string): void {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ error: { code, message } });
  }

  /** No log line holds any of `privates`. */
  function expectNotLogged(...privates: string[]): void {
    expect(logLines.length).toBeGreaterThan(0);
    for (const value of privates) {
      expect(logLines.filter((line) => line.includes(value))).toEqual([]);
    }
  }

  /** The log lines, parsed. */
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
    return { account, group, access };
  };

  const path = (organizationId: string, configurationId?: string) =>
    `/api/v1/organizations/${organizationId}/configurations${configurationId === undefined ? "" : `/${configurationId}`}`;

  const publish = (
    access: string | undefined,
    organizationId: string,
    configurationId: string,
    versionId: string,
    headers: Record<string, string> = csrfHeaders,
  ) =>
    server.inject({
      method: "POST",
      url: `${path(organizationId, configurationId)}/versions/${versionId}/publish`,
      headers,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  /** A publish with a body: `payload` as JSON, or `body` raw with its own content type. */
  const publishWith = (
    access: string,
    organizationId: string,
    configurationId: string,
    versionId: string,
    request: { payload: unknown } | { body: string; contentType: string },
  ) =>
    server.inject({
      method: "POST",
      url: `${path(organizationId, configurationId)}/versions/${versionId}/publish`,
      cookies: { telflo_access: access },
      ...("payload" in request
        ? { headers: csrfHeaders, payload: request.payload as Record<string, unknown> }
        : { headers: { ...csrfHeaders, "content-type": request.contentType }, payload: request.body }),
    });

  /** The version's updatedAt as the editor last read it: its summary's, from the version's read. */
  const updatedAtSeen = async (access: string, organizationId: string, configurationId: string, versionId: string) => {
    const response = await server.inject({
      method: "GET",
      url: `${path(organizationId, configurationId)}/versions/${versionId}`,
      cookies: { telflo_access: access },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ version: { updatedAt: string } }>().version.updatedAt;
  };

  /** The snapshots' ids the fake holds for the configuration, sorted. */
  const snapshotIdsIn = async (organizationId: string, configurationId: string) =>
    (await snapshotsIn(organizationId, configurationId)).map((snapshot) => snapshot.id).sort();

  const created = async (access: string, organizationId: string, name: string) => {
    const response = await server.inject({
      method: "POST",
      url: path(organizationId),
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { name },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ configuration: ConfigurationBody }>().configuration;
  };

  const save = (access: string, organizationId: string, configurationId: string, versionId: string, yaml: string) =>
    server.inject({
      method: "PATCH",
      url: `${path(organizationId, configurationId)}/versions/${versionId}`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { yamlContent: yaml, ...EMPTY_GRAPH },
    });

  const saved = async (
    access: string,
    organizationId: string,
    configurationId: string,
    versionId: string,
    yaml: string,
  ) => {
    expect((await save(access, organizationId, configurationId, versionId, yaml)).statusCode).toBe(200);
  };

  const relabelled = async (
    access: string,
    organizationId: string,
    configurationId: string,
    versionId: string,
    label: string,
  ) => {
    const response = await server.inject({
      method: "PUT",
      url: `${path(organizationId, configurationId)}/versions/${versionId}/label`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { label },
    });
    expect(response.statusCode).toBe(200);
  };

  const newVersion = async (
    access: string,
    organizationId: string,
    configurationId: string,
    sourceVersionId: string,
    yaml: string,
  ) => {
    const response = await server.inject({
      method: "POST",
      url: `${path(organizationId, configurationId)}/versions`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { sourceVersionId, yamlContent: yaml, ...EMPTY_GRAPH },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ version: { id: string } }>().version;
  };

  /** A save of the version's YAML and an empty graph, pinning it to `collectorVersion`. */
  const pinned = (
    access: string,
    organizationId: string,
    configurationId: string,
    versionId: string,
    yaml: string,
    collectorVersion: string,
  ) =>
    server.inject({
      method: "PATCH",
      url: `${path(organizationId, configurationId)}/versions/${versionId}`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { yamlContent: yaml, ...EMPTY_GRAPH, collectorVersion },
    });

  /** A version of `distribution` the catalog offers other than `pin`. */
  const anotherOfferedPin = async (distribution: string, pin: string) =>
    (
      await ownerDb
        .selectFrom("collector_versions")
        .select("version")
        .where("distribution", "=", distribution)
        .where("version", "<>", pin)
        .where("deprecated", "=", false)
        .orderBy("version")
        .executeTakeFirstOrThrow()
    ).version;

  const readConfiguration = async (access: string, organizationId: string, configurationId: string) => {
    const response = await server.inject({
      method: "GET",
      url: path(organizationId, configurationId),
      cookies: { telflo_access: access },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ configuration: ConfigurationBody }>().configuration;
  };

  const configurationRow = (id: string) =>
    ownerDb.selectFrom("configurations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  const versionRow = (id: string) =>
    ownerDb.selectFrom("configuration_versions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  const versionNumbered = (configurationId: string, versionNumber: number) =>
    ownerDb
      .selectFrom("configuration_versions")
      .selectAll()
      .where("configuration_id", "=", configurationId)
      .where("version_number", "=", versionNumber)
      .executeTakeFirstOrThrow();

  const publishAudits = () =>
    ownerDb
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "configuration.version_published")
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();

  /** The version is a draft: every publish column null. */
  const expectDraft = async (versionId: string) => {
    expect(await versionRow(versionId)).toMatchObject({
      published_at: null,
      publication_id: null,
      published_by_user_id: null,
    });
  };

  /**
   * A fleet of the organization in the fake, created through its own client
   * as the person: its id and its Default group's.
   */
  const fleetIn = async (organizationId: string, userId: string, email: string) => {
    const result = await opamp.client.createFleet(organizationId, {
      id: randomUUID(),
      label: `fleet-${randomUUID()}`,
      type: "server",
      rotateExpiresAt: null,
      actor: { id: userId, email },
    });
    if (result.kind !== "created") throw new Error(`the fake's createFleet answered ${result.kind}`);
    return { fleetId: result.fleet.id, defaultGroupId: result.defaultGroup.id };
  };

  /**
   * A personal user with a configuration whose version 1 holds `yaml`
   * (saved at the clock's time), labeled `label` unless null.
   */
  const withSavedVersion = async ({
    yaml = yamlWith(`marker-${randomUUID()}`),
    label = null,
    name = `Payments gateway ${randomUUID()}`,
  }: { yaml?: string; label?: string | null; name?: string } = {}) => {
    const { account, organization, access } = await personalUser();
    const configuration = await created(access, organization.id, name);
    const version = await versionNumbered(configuration.id, 1);
    await saved(access, organization.id, configuration.id, version.id, yaml);
    if (label !== null) await relabelled(access, organization.id, configuration.id, version.id, label);
    calls = [];
    return { account, organization, access, configuration, version, yaml, label, name };
  };

  describe("POST …/versions/:versionId/publish", () => {
    it("puts exactly the saved version, records it, and answers its summary, now published", async () => {
      const marker = `marker-${randomUUID()}`;
      const label = `TLS on ☕ ${randomUUID().slice(0, 8)}`;
      const { account, organization, access, configuration, version, yaml, name } = await withSavedVersion({
        yaml: yamlWith(marker),
        label,
      });
      // The last save's: a millisecond past the clock, since it shares the
      // creation's.
      const savedAt = (await versionRow(version.id)).updated_at;
      expect(savedAt.getTime()).toBe(clock.getTime() + 1);
      // A millisecond the snapshot and the record must both keep.
      tick(1_234);

      const response = await publish(access, organization.id, configuration.id, version.id);

      expect(response.statusCode).toBe(200);
      // The organization ensured, then the one put; nothing else.
      expect(operations()).toEqual(["createOrganization", "postPublication"]);
      expect(calls[0]!.args).toEqual([{ id: organization.id, name: organization.name }]);
      const [put] = puts();
      expect(put!.organizationId).toBe(organization.id);
      expect(put!.publicationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(put!.publication).toEqual({
        configuration: { id: configuration.id, name },
        version: { id: version.id, number: 1, label },
        yaml,
        sha256: createHash("sha256").update(Buffer.from(yaml, "utf8")).digest("hex"),
        publishedBy: { id: account.user.id, email: account.user.email },
        publishedAt: clock.toISOString(),
        // The configuration's distribution and the version's pin.
        collector: {
          distribution: (await configurationRow(configuration.id)).collector_distribution,
          version: version.collector_version,
        },
      });

      // What the fake keeps is the saved text, byte for byte.
      const stored = await opamp.client.getPublication(organization.id, put!.publicationId);
      if (stored.kind !== "found") throw new Error(`the fake answered ${stored.kind}`);
      expect(Buffer.from(stored.publication.yaml, "utf8").equals(Buffer.from(yaml, "utf8"))).toBe(true);
      expect(stored.publication.yaml.endsWith("\n")).toBe(true);
      expect(stored.publication.sha256).toBe(put!.publication.sha256);
      expect(stored.publication.publishedAt).toBe(clock.toISOString());

      // The record: the same instant to the millisecond, the id put, the caller.
      const row = await versionRow(version.id);
      expect(row.published_at!.getTime()).toBe(Date.parse(put!.publication.publishedAt));
      expect(row.published_at!.getUTCMilliseconds()).toBe(234);
      expect(row.publication_id).toBe(put!.publicationId);
      expect(row.published_by_user_id).toBe(account.user.id);
      expect(row.yaml_content).toBe(yaml);
      // The version's updated_at stays its last save; the configuration's moves.
      expect(row.updated_at).toEqual(savedAt);
      expect((await configurationRow(configuration.id)).updated_at).toEqual(clock);

      expect(response.json<{ version: VersionSummaryBody }>()).toEqual({
        version: {
          id: version.id,
          versionNumber: 1,
          label,
          createdBy: { userId: account.user.id, email: account.user.email },
          createdAt: version.created_at.toISOString(),
          updatedAt: savedAt.toISOString(),
          publishedAt: clock.toISOString(),
          publishedBy: { userId: account.user.id, email: account.user.email },
          // Its pin, which the catalog offers.
          collectorVersion: version.collector_version,
          collectorVersionDeprecated: false,
          collectorVersionDeprecatedNote: null,
        },
      });
      expect((await readConfiguration(access, organization.id, configuration.id)).published).toBe(true);
      expectNotLogged(marker, yaml, name, label, account.user.email, FAKE_OPAMP_SERVER_SECRET);
    });

    it("sends the configuration's distribution and the version's pin as the snapshot's collector, which the opamp-server keeps exactly", async () => {
      const { organization, access, configuration, version, yaml } = await withSavedVersion();
      const other = await anotherOfferedPin(version.collector_distribution, version.collector_version);
      const repinned = await pinned(access, organization.id, configuration.id, version.id, yaml, other);
      expect(repinned.statusCode).toBe(200);
      calls = [];
      tick();

      const response = await publish(access, organization.id, configuration.id, version.id);

      expect(response.statusCode).toBe(200);
      const distribution = (await configurationRow(configuration.id)).collector_distribution;
      expect((await versionRow(version.id)).collector_version).toBe(other);
      const [put] = puts();
      // Exactly the pin and the distribution: the two fields and nothing else.
      expect(put!.publication.collector).toStrictEqual({ distribution, version: other });
      // What the opamp-server keeps, and answers in its list.
      const stored = await opamp.client.getPublication(organization.id, put!.publicationId);
      if (stored.kind !== "found") throw new Error(`the fake answered ${stored.kind}`);
      expect(stored.publication.collector).toStrictEqual({ distribution, version: other });
      expect((await snapshotsIn(organization.id, configuration.id)).map((snapshot) => snapshot.collector)).toEqual([
        { distribution, version: other },
      ]);
      expect(response.json<{ version: VersionSummaryBody }>().version).toMatchObject({
        collectorVersion: other,
        publishedAt: clock.toISOString(),
      });
    });

    it("refuses with 409 configuration_version_changed when a save changes only the collector version between the put and the record, and removes the snapshot after the response", async () => {
      const { organization, access, configuration, version, yaml } = await withSavedVersion();
      const other = await anotherOfferedPin(version.collector_distribution, version.collector_version);
      const gate = createGate();
      hooks.postPublication = async (...args) => {
        const answer = await opamp.client.postPublication(...args);
        await gate.hold();
        return answer;
      };

      const pending = publish(access, organization.id, configuration.id, version.id);
      await gate.reached;
      // The same YAML and graph: only the pin the snapshot holds is gone.
      tick();
      expect((await pinned(access, organization.id, configuration.id, version.id, yaml, other)).statusCode).toBe(200);
      const savedRow = await configurationRow(configuration.id);
      gate.release();
      const response = await pending;

      expectRefusal(response, 409, "configuration_version_changed", MESSAGES.changed);
      expect(puts()[0]!.publication.collector.version).toBe(version.collector_version);
      await expectDraft(version.id);
      expect(await versionRow(version.id)).toMatchObject({ yaml_content: yaml, collector_version: other });
      // The record touched nothing: the configuration is as the save left it.
      expect(await configurationRow(configuration.id)).toEqual(savedRow);
      expect(await publishAudits()).toEqual([]);
      expect(await snapshotIdsIn(organization.id, configuration.id)).toEqual([puts()[0]!.publicationId]);

      await runner.settle();

      expect(await snapshotsIn(organization.id, configuration.id)).toEqual([]);
      await expectDraft(version.id);
    });

    it("audits configuration.version_published with the version's id and number and the publication's id only", async () => {
      const marker = `marker-${randomUUID()}`;
      const { account, organization, access, configuration, version, name } = await withSavedVersion({
        yaml: yamlWith(marker),
        label: "Audited label",
      });

      expect((await publish(access, organization.id, configuration.id, version.id)).statusCode).toBe(200);

      const audits = await publishAudits();
      expect(audits).toEqual([
        {
          id: expect.any(String),
          occurred_at: expect.any(Date),
          action: "configuration.version_published",
          actor_user_id: account.user.id,
          actor_email: account.user.email,
          organization_id: organization.id,
          subject_type: "configuration",
          subject_id: configuration.id,
          metadata: { versionId: version.id, versionNumber: 1, publicationId: puts()[0]!.publicationId },
          ip_address: expect.any(String),
          user_agent: expect.any(String),
        },
      ]);
      const metadata = JSON.stringify(audits[0]!.metadata);
      for (const value of [marker, name, "Audited label", account.user.email]) expect(metadata).not.toContain(value);
    });

    it("publishes a version only once: again is 409 configuration_version_published, with no second call", async () => {
      const { organization, access, configuration, version } = await withSavedVersion();
      expect((await publish(access, organization.id, configuration.id, version.id)).statusCode).toBe(200);
      const first = await versionRow(version.id);
      calls = [];
      tick();

      const again = await publish(access, organization.id, configuration.id, version.id);

      expectRefusal(again, 409, "configuration_version_published", MESSAGES.alreadyPublished(1));
      expect(calls).toEqual([]);
      expect(await versionRow(version.id)).toEqual(first);
      expect(await snapshotsIn(organization.id, configuration.id)).toHaveLength(1);
      expect(await publishAudits()).toHaveLength(1);
    });

    it("gives two concurrent publishes of one version one 200 and one 409, one record, and, once the loser's snapshot is removed after the response, one snapshot", async () => {
      const { account, organization, access, configuration, version } = await withSavedVersion();
      // The first publish's put is held once the fake has taken it, until
      // the second has passed its checks, put and recorded.
      const gate = createGate();
      let held = false;
      hooks.postPublication = async (...args) => {
        const answer = await opamp.client.postPublication(...args);
        if (!held) {
          held = true;
          await gate.hold();
        }
        return answer;
      };

      const first = publish(access, organization.id, configuration.id, version.id);
      await gate.reached;
      const second = await publish(access, organization.id, configuration.id, version.id);
      gate.release();
      const firstResponse = await first;

      expect(second.statusCode).toBe(200);
      expectRefusal(firstResponse, 409, "configuration_version_published", MESSAGES.alreadyPublished(1));
      const [firstPut, secondPut] = puts();
      expect(puts()).toHaveLength(2);
      expect(firstPut!.publicationId).not.toBe(secondPut!.publicationId);
      // One record: the second's publication.
      expect(await versionRow(version.id)).toMatchObject({
        publication_id: secondPut!.publicationId,
        published_by_user_id: account.user.id,
      });
      expect(second.json<{ version: VersionSummaryBody }>().version.publishedAt).toBe(clock.toISOString());
      expect(await publishAudits()).toEqual([
        expect.objectContaining({ metadata: expect.objectContaining({ publicationId: secondPut!.publicationId }) }),
      ]);
      // Two snapshots until the response has gone: the loser's is removed
      // after it, by its id.
      expect(await snapshotIdsIn(organization.id, configuration.id)).toEqual(
        [firstPut!.publicationId, secondPut!.publicationId].sort(),
      );
      expect(operations()).not.toContain("deletePublication");

      await runner.settle();

      expect(calls.filter((call) => call.operation === "deletePublication")).toEqual([
        { operation: "deletePublication", args: [organization.id, firstPut!.publicationId] },
      ]);
      expect(await snapshotIdsIn(organization.id, configuration.id)).toEqual([secondPut!.publicationId]);
      expect(await versionRow(version.id)).toMatchObject({ publication_id: secondPut!.publicationId });
      expect(logged().filter((entry) => (entry.level as number) >= 50)).toEqual([]);
    });

    it("refuses with 409 configuration_version_changed when a save lands between the put and the record, leaving a draft, and removes the snapshot after the response", async () => {
      const marker = `marker-${randomUUID()}`;
      const { account, organization, access, configuration, version, yaml, name } = await withSavedVersion({
        yaml: yamlWith(marker),
      });
      const before = await configurationRow(configuration.id);
      const gate = createGate();
      hooks.postPublication = async (...args) => {
        const answer = await opamp.client.postPublication(...args);
        await gate.hold();
        return answer;
      };

      const pending = publish(access, organization.id, configuration.id, version.id);
      await gate.reached;
      // No lock is held across the call, so the save goes through.
      tick();
      await saved(access, organization.id, configuration.id, version.id, "receivers: {}\n");
      const savedRow = await configurationRow(configuration.id);
      gate.release();
      const response = await pending;

      expectRefusal(response, 409, "configuration_version_changed", MESSAGES.changed);
      await expectDraft(version.id);
      expect((await versionRow(version.id)).yaml_content).toBe("receivers: {}\n");
      expect(await configurationRow(configuration.id)).toEqual(savedRow);
      expect(savedRow.updated_at).not.toEqual(before.updated_at);
      expect(await publishAudits()).toEqual([]);
      const snapshots = await snapshotsIn(organization.id, configuration.id);
      expect(snapshots.map((snapshot) => snapshot.id)).toEqual([puts()[0]!.publicationId]);
      expect(snapshots[0]!.sha256).toBe(createHash("sha256").update(yaml, "utf8").digest("hex"));

      await runner.settle();

      expect(await snapshotsIn(organization.id, configuration.id)).toEqual([]);
      await expectDraft(version.id);
      expect(logged()).toContainEqual(
        expect.objectContaining({
          level: 40,
          organizationId: organization.id,
          configurationId: configuration.id,
          versionId: version.id,
          publicationId: puts()[0]!.publicationId,
          msg: "the publish wasn't recorded: its snapshot will be removed",
        }),
      );
      expectNotLogged(marker, name, account.user.email, FAKE_OPAMP_SERVER_SECRET);
    });

    it("keeps the unrecorded snapshot, an orphan, with a warning naming ids only, when the opamp-server is down at the clean-up", async () => {
      const marker = `marker-${randomUUID()}`;
      const { account, organization, access, configuration, version, name } = await withSavedVersion({
        yaml: yamlWith(marker),
        label: "Kept label",
      });
      const gate = createGate();
      hooks.postPublication = async (...args) => {
        const answer = await opamp.client.postPublication(...args);
        await gate.hold();
        return answer;
      };

      const pending = publish(access, organization.id, configuration.id, version.id);
      await gate.reached;
      tick();
      await saved(access, organization.id, configuration.id, version.id, "receivers: {}\n");
      gate.release();
      expectRefusal(await pending, 409, "configuration_version_changed", MESSAGES.changed);
      const orphanId = puts()[0]!.publicationId;
      opamp.fake.nextFault("error_500");

      await runner.settle();

      expect(calls.filter((call) => call.operation === "deletePublication")).toEqual([
        { operation: "deletePublication", args: [organization.id, orphanId] },
      ]);
      expect(await snapshotIdsIn(organization.id, configuration.id)).toEqual([orphanId]);
      expect(logged()).toContainEqual(
        expect.objectContaining({
          level: 40,
          msg: "the opamp-server didn't delete the unrecorded publish's snapshot: it is an orphan",
          operation: "deletePublication",
          organizationId: organization.id,
          configurationId: configuration.id,
          versionId: version.id,
          publicationId: orphanId,
          result: "unavailable",
          reason: "server_error",
          status: 500,
        }),
      );
      expectNotLogged(marker, name, "Kept label", account.user.email, FAKE_OPAMP_SERVER_SECRET);
    });

    it("keeps the unrecorded snapshot with a warning naming ids only, not an error, when the opamp-server says it is in use", async () => {
      const marker = `marker-${randomUUID()}`;
      const { account, organization, access, configuration, version, name } = await withSavedVersion({
        yaml: yamlWith(marker),
        label: "Kept label",
      });
      const gate = createGate();
      hooks.postPublication = async (...args) => {
        const answer = await opamp.client.postPublication(...args);
        await gate.hold();
        return answer;
      };

      const pending = publish(access, organization.id, configuration.id, version.id);
      await gate.reached;
      tick();
      await saved(access, organization.id, configuration.id, version.id, "receivers: {}\n");
      gate.release();
      expectRefusal(await pending, 409, "configuration_version_changed", MESSAGES.changed);
      const keptId = puts()[0]!.publicationId;
      opamp.fake.markPublicationInUse(organization.id, keptId);

      await runner.settle();

      expect(await snapshotIdsIn(organization.id, configuration.id)).toEqual([keptId]);
      const cleanUp = logged().filter((entry) => entry.operation === "deletePublication");
      expect(cleanUp).toEqual([
        expect.objectContaining({
          level: 40,
          msg: "the unrecorded publish's snapshot is in use in the opamp-server: it was kept",
          organizationId: organization.id,
          configurationId: configuration.id,
          versionId: version.id,
          publicationId: keptId,
          result: "in_use",
        }),
      ]);
      expect(logged().filter((entry) => (entry.level as number) >= 50)).toEqual([]);
      expectNotLogged(marker, name, "Kept label", account.user.email, FAKE_OPAMP_SERVER_SECRET);
    });

    it("refuses with 409 configuration_version_changed when a rename lands between the put and the record, and removes the snapshot after the response", async () => {
      const { organization, access, configuration, version } = await withSavedVersion({ label: "Put label" });
      const before = await configurationRow(configuration.id);
      const gate = createGate();
      hooks.postPublication = async (...args) => {
        const answer = await opamp.client.postPublication(...args);
        await gate.hold();
        return answer;
      };

      const pending = publish(access, organization.id, configuration.id, version.id);
      await gate.reached;
      // The YAML stays the same: only the label the snapshot holds is gone.
      await relabelled(access, organization.id, configuration.id, version.id, "Renamed label");
      gate.release();
      const response = await pending;

      expectRefusal(response, 409, "configuration_version_changed", MESSAGES.changed);
      expect(puts()[0]!.publication.version.label).toBe("Put label");
      await expectDraft(version.id);
      expect((await versionRow(version.id)).label).toBe("Renamed label");
      // A rename moves neither updated_at; the record touched nothing.
      expect(await configurationRow(configuration.id)).toEqual(before);
      expect(await publishAudits()).toEqual([]);

      await runner.settle();

      expect(await snapshotsIn(organization.id, configuration.id)).toEqual([]);
    });

    it("answers 500 for a failure in the record's transaction, recording nothing, and removes the snapshot after the response", async () => {
      const { organization, access, configuration, version } = await withSavedVersion();
      const gate = createGate();
      hooks.postPublication = async (...args) => {
        const answer = await opamp.client.postPublication(...args);
        await gate.hold();
        return answer;
      };

      const pending = publish(access, organization.id, configuration.id, version.id);
      await gate.reached;
      // The record's own clock read (the configuration's touch) is now one
      // Postgres refuses, after the record's statement: the transaction
      // fails and rolls back. The snapshot's publishedAt was read before.
      const valid = clock;
      clock = new Date(Number.NaN);
      gate.release();
      const response = await pending;
      clock = valid;

      expectRefusal(response, 500, "internal_error", MESSAGES.internal);
      await expectDraft(version.id);
      expect(await publishAudits()).toEqual([]);
      expect(await snapshotsIn(organization.id, configuration.id)).toHaveLength(1);

      await runner.settle();

      expect(await snapshotsIn(organization.id, configuration.id)).toEqual([]);
    });

    it("keeps the snapshot when a version records it after all (a record whose commit's answer was lost)", async () => {
      const { organization, access, configuration, version } = await withSavedVersion();
      const gate = createGate();
      hooks.postPublication = async (...args) => {
        const answer = await opamp.client.postPublication(...args);
        await gate.hold();
        return answer;
      };

      const pending = publish(access, organization.id, configuration.id, version.id);
      await gate.reached;
      await saved(access, organization.id, configuration.id, version.id, "receivers: {}\n");
      gate.release();
      expectRefusal(await pending, 409, "configuration_version_changed", MESSAGES.changed);
      // Stands in for a commit that happened though its answer was lost:
      // the version records the publication the clean-up was queued for.
      const publicationId = puts()[0]!.publicationId;
      await ownerDb
        .updateTable("configuration_versions")
        .set({ published_at: clock, publication_id: publicationId })
        .where("id", "=", version.id)
        .execute();

      await runner.settle();

      expect(operations()).not.toContain("deletePublication");
      expect(await snapshotIdsIn(organization.id, configuration.id)).toEqual([publicationId]);
    });

    describe("the version the caller's tab saw: expectedUpdatedAt", () => {
      /** A published configuration's draft version 2 in a group, which its creator's tab and a teammate both see. */
      const sharedDraft = async () => {
        const creator = await memberActiveInGroup("admin");
        const teammate = await memberActiveInGroup("contributor", creator.group.id);
        const configuration = await created(creator.access, creator.group.id, "Shared");
        const first = await versionNumbered(configuration.id, 1);
        await saved(creator.access, creator.group.id, configuration.id, first.id, "receivers: {}\n");
        expect((await publish(creator.access, creator.group.id, configuration.id, first.id)).statusCode).toBe(200);
        tick();
        const draft = await newVersion(creator.access, creator.group.id, configuration.id, first.id, "exporters: {}\n");
        calls = [];
        return { creator, teammate, configuration, draft };
      };

      it("refuses a teammate's save the tab didn't see with 409 configuration_version_changed, calling nothing", async () => {
        const { creator, teammate, configuration, draft } = await sharedDraft();
        const seen = await updatedAtSeen(creator.access, creator.group.id, configuration.id, draft.id);
        const before = await configurationRow(configuration.id);
        tick();
        await saved(teammate.access, creator.group.id, configuration.id, draft.id, "exporters: {debug: {}}\n");
        const afterSave = await configurationRow(configuration.id);
        calls = [];

        const response = await publishWith(creator.access, creator.group.id, configuration.id, draft.id, {
          payload: { expectedUpdatedAt: seen },
        });

        expectRefusal(response, 409, "configuration_version_changed", MESSAGES.changed);
        expect(calls).toEqual([]);
        await expectDraft(draft.id);
        expect(await configurationRow(configuration.id)).toEqual(afterSave);
        expect(afterSave.updated_at).not.toEqual(before.updated_at);
        expect(await publishAudits()).toHaveLength(1);
        await runner.settle();
        expect(calls).toEqual([]);
      });

      it("refuses a save of the same text the tab didn't see too: a save is what it compares, to the millisecond", async () => {
        const { creator, configuration, draft } = await sharedDraft();
        const seen = await updatedAtSeen(creator.access, creator.group.id, configuration.id, draft.id);
        tick(1);
        await saved(creator.access, creator.group.id, configuration.id, draft.id, "exporters: {}\n");
        calls = [];

        expectRefusal(
          await publishWith(creator.access, creator.group.id, configuration.id, draft.id, {
            payload: { expectedUpdatedAt: seen },
          }),
          409,
          "configuration_version_changed",
          MESSAGES.changed,
        );
        expect(calls).toEqual([]);
      });

      it("refuses a save in the same clock millisecond as the one the tab saw: every save moves updatedAt forward", async () => {
        const { creator, teammate, configuration, draft } = await sharedDraft();
        const savedAt = async (access: string, yaml: string) => {
          const response = await save(access, creator.group.id, configuration.id, draft.id, yaml);
          expect(response.statusCode).toBe(200);
          return response.json<{ version: { updatedAt: string } }>().version.updatedAt;
        };
        // Past the draft's creation, then frozen: both saves read the same millisecond.
        tick();
        const first = await savedAt(creator.access, "exporters: {}\n");
        const second = await savedAt(teammate.access, "exporters: {debug: {}}\n");
        expect(first).toBe(clock.toISOString());
        expect(Date.parse(second)).toBe(Date.parse(first) + 1);
        // What a read reports is the second save's, as the response said.
        expect(await updatedAtSeen(creator.access, creator.group.id, configuration.id, draft.id)).toBe(second);
        calls = [];

        expectRefusal(
          await publishWith(creator.access, creator.group.id, configuration.id, draft.id, {
            payload: { expectedUpdatedAt: first },
          }),
          409,
          "configuration_version_changed",
          MESSAGES.changed,
        );
        expect(calls).toEqual([]);
        await expectDraft(draft.id);

        const response = await publishWith(creator.access, creator.group.id, configuration.id, draft.id, {
          payload: { expectedUpdatedAt: second },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json<{ version: VersionSummaryBody }>().version).toMatchObject({
          id: draft.id,
          updatedAt: second,
        });
        expect(operations()).toEqual(["createOrganization", "postPublication"]);
        expect(puts()[0]!.publication.yaml).toBe("exporters: {debug: {}}\n");
      });

      it("publishes when the version is the save the tab saw", async () => {
        const { creator, teammate, configuration, draft } = await sharedDraft();
        tick();
        await saved(teammate.access, creator.group.id, configuration.id, draft.id, "exporters: {debug: {}}\n");
        // The tab reloaded the teammate's save.
        const seen = await updatedAtSeen(creator.access, creator.group.id, configuration.id, draft.id);
        calls = [];
        tick();

        const response = await publishWith(creator.access, creator.group.id, configuration.id, draft.id, {
          payload: { expectedUpdatedAt: seen },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json<{ version: VersionSummaryBody }>().version).toMatchObject({
          id: draft.id,
          updatedAt: seen,
          publishedAt: clock.toISOString(),
        });
        expect(operations()).toEqual(["createOrganization", "postPublication"]);
        expect(puts()[0]!.publication.yaml).toBe("exporters: {debug: {}}\n");
      });

      it("publishes what is saved when the caller sends no body, or an empty one, as the public API does", async () => {
        const { creator, configuration, draft } = await sharedDraft();
        const second = await newVersion(
          creator.access,
          creator.group.id,
          configuration.id,
          draft.id,
          "processors: {}\n",
        );
        calls = [];

        expect((await publish(creator.access, creator.group.id, configuration.id, draft.id)).statusCode).toBe(200);
        expect(
          (await publishWith(creator.access, creator.group.id, configuration.id, second.id, { payload: {} })).statusCode,
        ).toBe(200);
        expect(puts().map((put) => put.publication.version.id)).toEqual([draft.id, second.id]);
      });

      it("answers a version published meanwhile as already published, whatever the tab saw", async () => {
        const { creator, teammate, configuration, draft } = await sharedDraft();
        const seen = await updatedAtSeen(creator.access, creator.group.id, configuration.id, draft.id);
        expect((await publish(teammate.access, creator.group.id, configuration.id, draft.id)).statusCode).toBe(200);
        calls = [];

        expectRefusal(
          await publishWith(creator.access, creator.group.id, configuration.id, draft.id, {
            payload: { expectedUpdatedAt: new Date(Date.parse(seen) - 1_000).toISOString() },
          }),
          409,
          "configuration_version_published",
          MESSAGES.alreadyPublished(2),
        );
        expect(calls).toEqual([]);
      });

      it.each<[string, { payload: unknown } | { body: string; contentType: string }]>([
        ["an unknown field", { payload: { expectedUpdatedAt: "2026-10-04T12:34:56.789Z", force: true } }],
        ["a timestamp without milliseconds", { payload: { expectedUpdatedAt: "2026-10-04T12:34:56Z" } }],
        ["a timestamp with an offset", { payload: { expectedUpdatedAt: "2026-10-04T14:34:56.789+02:00" } }],
        ["a number", { payload: { expectedUpdatedAt: 1_791_117_296_789 } }],
        ["null", { payload: { expectedUpdatedAt: null } }],
        ["an array", { payload: ["2026-10-04T12:34:56.789Z"] }],
        ["JSON that doesn't parse", { body: "{\"expectedUpdatedAt\":", contentType: "application/json" }],
        ["an empty JSON body", { body: "", contentType: "application/json" }],
        ["text", { body: "2026-10-04T12:34:56.789Z", contentType: "text/plain" }],
      ])("refuses %s with 400, calling nothing", async (_label, request) => {
        const { organization, access, configuration, version } = await withSavedVersion();

        const response = await publishWith(access, organization.id, configuration.id, version.id, request);

        expect(response.statusCode).toBe(400);
        expect(response.json<{ error: { code: string } }>().error.code).toBe("invalid_request");
        expect(calls).toEqual([]);
        await expectDraft(version.id);
      });
    });

    it("publishes a version whose text a save left the same between the put and the record", async () => {
      const { organization, access, configuration, version, yaml } = await withSavedVersion();
      const gate = createGate();
      hooks.postPublication = async (...args) => {
        const answer = await opamp.client.postPublication(...args);
        await gate.hold();
        return answer;
      };

      const pending = publish(access, organization.id, configuration.id, version.id);
      await gate.reached;
      await saved(access, organization.id, configuration.id, version.id, yaml);
      gate.release();

      expect((await pending).statusCode).toBe(200);
      expect((await versionRow(version.id)).publication_id).toBe(puts()[0]!.publicationId);
    });

    it("refuses an empty version with 409 configuration_version_empty, before any call to the opamp-server", async () => {
      const { organization, access } = await personalUser();
      const configuration = await created(access, organization.id, "Empty");
      const version = await versionNumbered(configuration.id, 1);
      expect(version.yaml_content).toBe("");
      calls = [];

      const response = await publish(access, organization.id, configuration.id, version.id);

      expectRefusal(response, 409, "configuration_version_empty", MESSAGES.empty);
      expect(calls).toEqual([]);
      await expectDraft(version.id);
      expect(await publishAudits()).toEqual([]);
    });

    describe("when the opamp-server can't take it: 503 publishing_unavailable, and a draft", () => {
      it.each<[string, FakeOpampServerFault]>([
        ["answers 500", "error_500"],
        ["resets the connection", "reset"],
      ])("the put's request %s: nothing recorded", async (_name, fault) => {
        const marker = `marker-${randomUUID()}`;
        const { account, organization, access, configuration, version, name } = await withSavedVersion({
          yaml: yamlWith(marker),
          label: "Unavailable label",
        });
        const before = await configurationRow(configuration.id);
        hooks.postPublication = (...args) => {
          opamp.fake.nextFault(fault);
          return opamp.client.postPublication(...args);
        };
        tick();

        const response = await publish(access, organization.id, configuration.id, version.id);

        expectRefusal(response, 503, "publishing_unavailable", MESSAGES.unavailable);
        expect(operations()).toEqual(["createOrganization", "postPublication"]);
        await expectDraft(version.id);
        expect(await configurationRow(configuration.id)).toEqual(before);
        expect(await publishAudits()).toEqual([]);
        expect(await snapshotsIn(organization.id, configuration.id)).toEqual([]);
        expect(logged()).toContainEqual(
          expect.objectContaining({
            level: 40,
            operation: "postPublication",
            organizationId: organization.id,
            configurationId: configuration.id,
            versionId: version.id,
            result: "unavailable",
          }),
        );
        expectNotLogged(marker, name, "Unavailable label", account.user.email, FAKE_OPAMP_SERVER_SECRET);
      });

      it("the put times out (the client's answer): nothing recorded", async () => {
        const { organization, access, configuration, version } = await withSavedVersion();
        hooks.postPublication = async () => ({ kind: "unavailable", reason: "timeout" });

        expectRefusal(
          await publish(access, organization.id, configuration.id, version.id),
          503,
          "publishing_unavailable",
          MESSAGES.unavailable,
        );
        await expectDraft(version.id);
        expect(await publishAudits()).toEqual([]);
      });

      it("the organization's create answers 500: nothing put, nothing recorded", async () => {
        const { organization, access, configuration, version } = await withSavedVersion();
        opamp.fake.nextFault("error_500");

        expectRefusal(
          await publish(access, organization.id, configuration.id, version.id),
          503,
          "publishing_unavailable",
          MESSAGES.unavailable,
        );
        expect(operations()).toEqual(["createOrganization"]);
        await expectDraft(version.id);
      });
    });

    describe("ensuring the organization", () => {
      it("registers an organization the opamp-server doesn't know, before the put", async () => {
        const { organization, access, configuration, version } = await withSavedVersion();
        expect((await opamp.client.getOrganization(organization.id)).kind).toBe("not_found");

        expect((await publish(access, organization.id, configuration.id, version.id)).statusCode).toBe(200);

        expect(operations()).toEqual(["createOrganization", "postPublication"]);
        expect(await opamp.client.getOrganization(organization.id)).toMatchObject({
          kind: "found",
          organization: { organizationId: organization.id, name: organization.name },
        });
      });

      it("renames one registered under an older name, then puts", async () => {
        const { organization, access, configuration, version } = await withSavedVersion();
        expect((await opamp.client.createOrganization({ id: organization.id, name: "An older name" })).kind).toBe(
          "created",
        );

        expect((await publish(access, organization.id, configuration.id, version.id)).statusCode).toBe(200);

        expect(operations()).toEqual(["createOrganization", "renameOrganization", "postPublication"]);
        expect(calls[1]!.args).toEqual([organization.id, organization.name]);
        expect(await opamp.client.getOrganization(organization.id)).toMatchObject({
          kind: "found",
          organization: { name: organization.name },
        });
      });

      it("goes on from one registered already under its name", async () => {
        const { organization, access, configuration, version } = await withSavedVersion();
        await opamp.client.createOrganization({ id: organization.id, name: organization.name });

        expect((await publish(access, organization.id, configuration.id, version.id)).statusCode).toBe(200);
        expect(operations()).toEqual(["createOrganization", "postPublication"]);
      });

      it("answers 503 when the rename finds it gone, putting nothing", async () => {
        const { organization, access, configuration, version } = await withSavedVersion();
        await opamp.client.createOrganization({ id: organization.id, name: "An older name" });
        // Deleted between the create's conflict and the rename.
        hooks.renameOrganization = async (organizationId, name) => {
          expect((await opamp.client.deleteOrganization(organizationId)).kind).toBe("deleted");
          return opamp.client.renameOrganization(organizationId, name);
        };

        expectRefusal(
          await publish(access, organization.id, configuration.id, version.id),
          503,
          "publishing_unavailable",
          MESSAGES.unavailable,
        );
        expect(operations()).toEqual(["createOrganization", "renameOrganization"]);
        await expectDraft(version.id);
      });

      it("answers 500 when the create is refused as invalid, putting nothing", async () => {
        const { organization, access, configuration, version } = await withSavedVersion();
        hooks.createOrganization = async () => ({
          kind: "invalid",
          code: "invalid_request",
        });

        expectRefusal(
          await publish(access, organization.id, configuration.id, version.id),
          500,
          "internal_error",
          MESSAGES.internal,
        );
        expect(operations()).toEqual(["createOrganization"]);
        await expectDraft(version.id);
      });

      it("answers 503 when the put finds the organization gone (a delete racing), recording nothing", async () => {
        const { organization, access, configuration, version } = await withSavedVersion();
        hooks.postPublication = async (organizationId, publicationId, publication) => {
          expect((await opamp.client.deleteOrganization(organizationId)).kind).toBe("deleted");
          return opamp.client.postPublication(organizationId, publicationId, publication);
        };

        expectRefusal(
          await publish(access, organization.id, configuration.id, version.id),
          503,
          "publishing_unavailable",
          MESSAGES.unavailable,
        );
        expect(logged()).toContainEqual(
          expect.objectContaining({ operation: "postPublication", result: "organization_not_found" }),
        );
        await expectDraft(version.id);
        expect(await publishAudits()).toEqual([]);
      });
    });

    describe("a reference no organization variable can have: 400 naming yaml, nothing written", () => {
      const TOO_LONG = "This configuration references an organization variable name over 128 characters, which no variable can have.";
      const ref = (name: string) => "${org:" + name + "}";
      const yamlReferencing = (name: string, marker: string) => `exporters:\n  otlp:\n    endpoint: ${ref(name)}\n# ${marker}\n`;

      const expectTooLong = (response: LightMyRequestResponse) => {
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: {
            code: "invalid_request",
            message: TOO_LONG,
            details: [
              {
                keyword: "custom",
                instancePath: "/yaml",
                schemaPath: "#/yaml/custom",
                params: { issue: { code: "custom", path: ["yaml"], message: TOO_LONG } },
                message: TOO_LONG,
              },
            ],
          },
        });
      };

      it("refuses a live reference to a 129-character name before any call: no put, no registration, the version a draft", async () => {
        const marker = `marker-${randomUUID()}`;
        const name = `A${"B".repeat(128)}`;
        const { organization, access, configuration, version } = await withSavedVersion({ yaml: yamlReferencing(name, marker) });

        expectTooLong(await publish(access, organization.id, configuration.id, version.id));
        expect(operations()).toEqual([]);
        await expectDraft(version.id);
        expect(await publishAudits()).toEqual([]);
        expect(opamp.fake.snapshotOf(organization.id)).toMatchObject({ organization: null, publications: [] });
        expectNotLogged(marker, name);
      });

      // One publish a test: four in one test neared the 5 s default under
      // load.
      it.each([
        ["a live reference to a 128-character name", () => yamlReferencing(`A${"B".repeat(127)}`, randomUUID())],
        ["an escaped reference to a longer name", () => `a: $${ref(`A${"B".repeat(200)}`)}\n`],
        ["a longer name in the legacy form", () => `a: $orgvar:A${"B".repeat(200)}\n`],
        ["a longer name with a default", () => `a: ${"${org:"}A${"B".repeat(200)}:-x}\n`],
      ])("publishes %s", async (_label, text) => {
        const yaml = text();
        const { organization, access, configuration, version } = await withSavedVersion({ yaml });
        const response = await publish(access, organization.id, configuration.id, version.id);
        expect(response.statusCode).toBe(200);
        expect(puts().map((put) => put.publication.yaml)).toEqual([yaml]);
      });

      it("maps the opamp-server's own 400 on the text (its backstop) to the same refusal, recording nothing", async () => {
        const marker = `marker-${randomUUID()}`;
        const { account, organization, access, configuration, version, name } = await withSavedVersion({ yaml: yamlWith(marker) });
        // The fake receives a text referencing a 129-character name, as a platform without its own check would send it.
        const tooLong = yamlReferencing(`A${"B".repeat(128)}`, marker);
        hooks.postPublication = (organizationId, publicationId, publication) =>
          opamp.client.postPublication(organizationId, publicationId, { ...publication, yaml: tooLong, sha256: createHash("sha256").update(tooLong, "utf8").digest("hex") });

        expectTooLong(await publish(access, organization.id, configuration.id, version.id));
        await expectDraft(version.id);
        expect(await publishAudits()).toEqual([]);
        expect(await snapshotsIn(organization.id, configuration.id)).toEqual([]);
        expect(logged().filter((line) => line.operation === "postPublication")).toEqual([
          expect.objectContaining({ level: 40, result: "invalid", code: "invalid_request", configurationId: configuration.id }),
        ]);
        expectNotLogged(marker, name, account.user.email, FAKE_OPAMP_SERVER_SECRET);
      });

      it("answers the put's other invalid codes (a hash that doesn't match, a 413) 500, the platform's own bug, recording nothing", async () => {
        const marker = `marker-${randomUUID()}`;
        const { account, organization, access, configuration, version, name } = await withSavedVersion({ yaml: yamlWith(marker) });
        hooks.postPublication = (organizationId, publicationId, publication) =>
          opamp.client.postPublication(organizationId, publicationId, { ...publication, sha256: "0".repeat(64) });

        expectRefusal(await publish(access, organization.id, configuration.id, version.id), 500, "internal_error", MESSAGES.internal);
        await expectDraft(version.id);
        expect(
          logLines.filter((line) => line.includes("The opamp-server answered postPublication with invalid (sha256_mismatch).")),
        ).toHaveLength(1);
        // The server's own text for the refusal stays out of the log.
        expect(logLines.filter((line) => line.toLowerCase().includes("sha256 doesn't") || line.includes("does not match"))).toEqual([]);

        hooks.postPublication = async () => ({ kind: "invalid", code: "payload_too_large" });
        expectRefusal(await publish(access, organization.id, configuration.id, version.id), 500, "internal_error", MESSAGES.internal);
        expect(
          logLines.filter((line) => line.includes("The opamp-server answered postPublication with invalid (payload_too_large).")),
        ).toHaveLength(1);
        await expectDraft(version.id);
        expect(await publishAudits()).toEqual([]);
        expectNotLogged(marker, name, account.user.email, FAKE_OPAMP_SERVER_SECRET);
      });
    });

    describe("an answer it can't go on from: 500, nothing recorded, the log naming the code only", () => {
      it("the put conflicts with another publication under the id", async () => {
        const marker = `marker-${randomUUID()}`;
        const { account, organization, access, configuration, version, name } = await withSavedVersion({
          yaml: yamlWith(marker),
        });
        // Another snapshot holds the id the put is sent under.
        await opamp.client.createOrganization({ id: organization.id, name: organization.name });
        const takenId = randomUUID();
        const other = {
          configuration: { id: randomUUID(), name: "Other" },
          version: { id: randomUUID(), number: 1, label: null },
          yaml: "other: {}\n",
          sha256: createHash("sha256").update("other: {}\n", "utf8").digest("hex"),
          publishedBy: null,
          publishedAt: clock.toISOString(),
          collector: { distribution: "otelcol-contrib", version: "0.162.0" },
        } satisfies PublicationRequest;
        expect((await opamp.client.postPublication(organization.id, takenId, other)).kind).toBe("created");
        hooks.postPublication = (organizationId, _publicationId, publication) =>
          opamp.client.postPublication(organizationId, takenId, publication);

        const response = await publish(access, organization.id, configuration.id, version.id);

        expectRefusal(response, 500, "internal_error", MESSAGES.internal);
        await expectDraft(version.id);
        expect(await publishAudits()).toEqual([]);
        expect(
          logLines.filter((line) => line.includes("The opamp-server answered postPublication with conflict.")),
        ).toHaveLength(1);
        expectNotLogged(marker, name, account.user.email, FAKE_OPAMP_SERVER_SECRET);
      });

      it("the opamp-server refuses the secret (401): a misconfiguration, logged without the secret or the YAML", async () => {
        const marker = `marker-${randomUUID()}`;
        const { account, organization, access, configuration, version, name } = await withSavedVersion({
          yaml: yamlWith(marker),
        });
        const wrongSecret = `wrong-secret-${randomUUID()}-0123456789abcdef`;
        const wrong = createOpampServerClient({ url: opamp.fake.url, secret: wrongSecret });
        delegate = () => wrong;

        const response = await publish(access, organization.id, configuration.id, version.id);

        expectRefusal(response, 500, "internal_error", MESSAGES.internal);
        await expectDraft(version.id);
        expect(
          logLines.filter((line) => line.includes("OpampServerMisconfigurationError") && line.includes("401")),
        ).toHaveLength(1);
        expectNotLogged(marker, name, account.user.email, wrongSecret, FAKE_OPAMP_SERVER_SECRET);
      });

      it("the put's reply breaks the contract: a misconfiguration, recording nothing", async () => {
        const { organization, access, configuration, version } = await withSavedVersion();
        hooks.postPublication = (...args) => {
          opamp.fake.nextFault("malformed_reply");
          return opamp.client.postPublication(...args);
        };

        expectRefusal(
          await publish(access, organization.id, configuration.id, version.id),
          500,
          "internal_error",
          MESSAGES.internal,
        );
        expect(opamp.fake.takeViolations()).toHaveLength(1);
        await expectDraft(version.id);
        expect(await publishAudits()).toEqual([]);
      });
    });

    describe("who may publish what", () => {
      it("lets a teammate publish a published configuration's draft version", async () => {
        const creator = await memberActiveInGroup("admin");
        const teammate = await memberActiveInGroup("contributor", creator.group.id);
        const configuration = await created(creator.access, creator.group.id, "Shared");
        const first = await versionNumbered(configuration.id, 1);
        await saved(creator.access, creator.group.id, configuration.id, first.id, "receivers: {}\n");
        expect((await publish(creator.access, creator.group.id, configuration.id, first.id)).statusCode).toBe(200);
        const draft = await newVersion(creator.access, creator.group.id, configuration.id, first.id, "exporters: {}\n");
        tick();

        const response = await publish(teammate.access, creator.group.id, configuration.id, draft.id);

        expect(response.statusCode).toBe(200);
        expect(response.json<{ version: VersionSummaryBody }>().version).toMatchObject({
          id: draft.id,
          versionNumber: 2,
          createdBy: { userId: creator.account.user.id, email: creator.account.user.email },
          publishedAt: clock.toISOString(),
          publishedBy: { userId: teammate.account.user.id, email: teammate.account.user.email },
        });
        expect(puts().at(-1)!.publication.publishedBy).toEqual({
          id: teammate.account.user.id,
          email: teammate.account.user.email,
        });
        expect(await snapshotsIn(creator.group.id, configuration.id)).toHaveLength(2);
      });

      // The record re-reads the membership under the organization's lock
      // (lockAsMember), so a member removed while the opamp-server took the
      // snapshot records nothing.
      it.each([
        [
          "their membership is removed",
          (organizationId: string, userId: string) =>
            ownerDb
              .updateTable("organization_members")
              .set({ deleted_at: new Date() })
              .where("organization_id", "=", organizationId)
              .where("user_id", "=", userId)
              .execute(),
        ],
        [
          "their account is removed",
          (_organizationId: string, userId: string) =>
            ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", userId).execute(),
        ],
      ])(
        "refuses the record with 404 organization_not_found when %s after the checks and the put, recording nothing, and removes the snapshot after the response",
        async (_case, remove) => {
          const creator = await memberActiveInGroup("admin");
          const teammate = await memberActiveInGroup("contributor", creator.group.id);
          const configuration = await created(creator.access, creator.group.id, "Shared");
          const first = await versionNumbered(configuration.id, 1);
          await saved(creator.access, creator.group.id, configuration.id, first.id, "receivers: {}\n");
          expect((await publish(creator.access, creator.group.id, configuration.id, first.id)).statusCode).toBe(200);
          const draft = await newVersion(creator.access, creator.group.id, configuration.id, first.id, "exporters: {}\n");
          const before = await configurationRow(configuration.id);
          calls = [];
          const gate = createGate();
          hooks.postPublication = async (...args) => {
            const answer = await opamp.client.postPublication(...args);
            await gate.hold();
            return answer;
          };

          const pending = publish(teammate.access, creator.group.id, configuration.id, draft.id);
          await gate.reached;
          await remove(creator.group.id, teammate.account.user.id);
          gate.release();
          const response = await pending;

          expectRefusal(response, 404, "organization_not_found", MESSAGES.organizationNotFound);
          expect(operations()).toEqual(["createOrganization", "postPublication"]);
          await expectDraft(draft.id);
          expect(await configurationRow(configuration.id)).toEqual(before);
          // The creator's publish of version 1 only.
          expect(await publishAudits()).toHaveLength(1);
          const unrecordedId = puts()[0]!.publicationId;
          const firstPublicationId = (await versionRow(first.id)).publication_id;
          expect(firstPublicationId).not.toBe(unrecordedId);
          const snapshots = await snapshotsIn(creator.group.id, configuration.id);
          expect(snapshots).toHaveLength(2);
          expect(snapshots.find((snapshot) => snapshot.id === unrecordedId)).toMatchObject({
            version: { id: draft.id, number: 2 },
            publishedBy: { id: teammate.account.user.id },
          });
          expect(logged()).toContainEqual(
            expect.objectContaining({
              level: 40,
              publicationId: unrecordedId,
              versionId: draft.id,
              msg: "the publish wasn't recorded: its snapshot will be removed",
            }),
          );

          await runner.settle();

          // Only the creator's publish of version 1 is left.
          expect(calls.filter((call) => call.operation === "deletePublication")).toEqual([
            { operation: "deletePublication", args: [creator.group.id, unrecordedId] },
          ]);
          expect(await snapshotIdsIn(creator.group.id, configuration.id)).toEqual([firstPublicationId]);
        },
      );

      it("answers another member's draft with 404 configuration_not_found, calling nothing", async () => {
        const creator = await memberActiveInGroup("admin");
        const teammate = await memberActiveInGroup("admin", creator.group.id);
        const configuration = await created(creator.access, creator.group.id, "Private");
        const version = await versionNumbered(configuration.id, 1);
        await saved(creator.access, creator.group.id, configuration.id, version.id, "receivers: {}\n");
        calls = [];

        expectRefusal(
          await publish(teammate.access, creator.group.id, configuration.id, version.id),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
        expect(calls).toEqual([]);
        await expectDraft(version.id);
      });

      it("answers an authorless, never-published configuration with 404 configuration_not_found", async () => {
        const { organization, access } = await personalUser();
        const configuration = await addConfiguration(ownerDb, { organizationId: organization.id });

        expectRefusal(
          await publish(access, organization.id, configuration.id, randomUUID()),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
        expect(calls).toEqual([]);
      });

      it("answers a version of another configuration, and an unknown one, with 404 configuration_version_not_found", async () => {
        const { organization, access, configuration } = await withSavedVersion();
        const other = await created(access, organization.id, "Other");
        const othersVersion = await versionNumbered(other.id, 1);
        await saved(access, organization.id, other.id, othersVersion.id, "receivers: {}\n");
        calls = [];

        for (const versionId of [othersVersion.id, randomUUID()]) {
          expectRefusal(
            await publish(access, organization.id, configuration.id, versionId),
            404,
            "configuration_version_not_found",
            MESSAGES.versionNotFound,
          );
        }
        expect(calls).toEqual([]);
        await expectDraft(othersVersion.id);
      });

      it.each(MALFORMED_PATH_IDS)(
        "answers the malformed configuration id %s with 404 configuration_not_found",
        async (id) => {
          const { organization, access, version } = await withSavedVersion();
          expectRefusal(
            await publish(access, organization.id, id, version.id),
            404,
            "configuration_not_found",
            MESSAGES.configurationNotFound,
          );
          expect(calls).toEqual([]);
        },
      );

      it.each(MALFORMED_PATH_IDS)(
        "answers the malformed version id %s with 404 configuration_version_not_found",
        async (id) => {
          const { organization, access, configuration, version } = await withSavedVersion();
          expectRefusal(
            await publish(access, organization.id, configuration.id, id),
            404,
            "configuration_version_not_found",
            MESSAGES.versionNotFound,
          );
          expect(calls).toEqual([]);
          await expectDraft(version.id);
        },
      );

      it("answers a deleted configuration with 404 configuration_not_found", async () => {
        const { organization, access, configuration, version } = await withSavedVersion();
        await ownerDb
          .updateTable("configurations")
          .set({ deleted_at: clock })
          .where("id", "=", configuration.id)
          .execute();

        expectRefusal(
          await publish(access, organization.id, configuration.id, version.id),
          404,
          "configuration_not_found",
          MESSAGES.configurationNotFound,
        );
        expect(calls).toEqual([]);
      });

      it("answers a path naming another organization with 404 organization_not_found", async () => {
        const { access, configuration, version } = await withSavedVersion();
        const elsewhere = await verifiedUser();

        expectRefusal(
          await publish(access, elsewhere.organization.id, configuration.id, version.id),
          404,
          "organization_not_found",
          MESSAGES.organizationNotFound,
        );
        expect(calls).toEqual([]);
        await expectDraft(version.id);
      });
    });

    describe("as every configuration write is guarded", () => {
      it("refuses a request without the CSRF header with 403 csrf_header_missing, calling nothing", async () => {
        const { organization, access, configuration, version } = await withSavedVersion();
        expectRefusal(
          await publish(access, organization.id, configuration.id, version.id, {}),
          403,
          "csrf_header_missing",
          MESSAGES.csrf,
        );
        expect(calls).toEqual([]);
        await expectDraft(version.id);
      });

      it("refuses a signed-out request with 401 unauthenticated, calling nothing", async () => {
        const { organization, configuration, version } = await withSavedVersion();
        expectRefusal(
          await publish(undefined, organization.id, configuration.id, version.id),
          401,
          "unauthenticated",
          MESSAGES.unauthenticated,
        );
        expect(calls).toEqual([]);
        await expectDraft(version.id);
      });

      it("refuses a user who hasn't accepted the current terms with 403 terms_acceptance_required, calling nothing", async () => {
        const { account, organization, access } = await personalUser({
          user: { accepted_terms_version: "2025-01-01" },
        });
        const configuration = await addConfiguration(ownerDb, {
          organizationId: organization.id,
          created_by_user_id: account.user.id,
        });
        const version = await addConfigurationVersion(ownerDb, {
          configurationId: configuration.id,
          organizationId: organization.id,
          yaml_content: "receivers: {}\n",
        });

        expectRefusal(
          await publish(access, organization.id, configuration.id, version.id),
          403,
          "terms_acceptance_required",
          MESSAGES.terms,
        );
        expect(calls).toEqual([]);
        await expectDraft(version.id);
      });
    });
  });

  const remove = (access: string, organizationId: string, configurationId: string, on: FastifyInstance = server) =>
    on.inject({
      method: "DELETE",
      url: path(organizationId, configurationId),
      headers: csrfHeaders,
      cookies: { telflo_access: access },
    });

  describe("DELETE …/configurations/:configurationId: its snapshots' clean-up", () => {
    it("removes the configuration's snapshots from the opamp-server after the response, and only its own", async () => {
      const { organization, access, configuration, version } = await withSavedVersion();
      expect((await publish(access, organization.id, configuration.id, version.id)).statusCode).toBe(200);
      const second = await newVersion(access, organization.id, configuration.id, version.id, "exporters: {}\n");
      expect((await publish(access, organization.id, configuration.id, second.id)).statusCode).toBe(200);
      const kept = await created(access, organization.id, "Kept");
      const keptVersion = await versionNumbered(kept.id, 1);
      await saved(access, organization.id, kept.id, keptVersion.id, "receivers: {}\n");
      expect((await publish(access, organization.id, kept.id, keptVersion.id)).statusCode).toBe(200);
      calls = [];

      expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
      // Only the usage asked; the clean-up not yet: the answer didn't wait for it.
      expect(calls).toEqual([{ operation: "getConfigurationUsage", args: [organization.id, configuration.id] }]);
      expect(await snapshotsIn(organization.id, configuration.id)).toHaveLength(2);

      await runner.settle();

      expect(calls.slice(1)).toEqual([
        { operation: "deleteConfigurationPublications", args: [organization.id, configuration.id] },
      ]);
      expect(await snapshotsIn(organization.id, configuration.id)).toEqual([]);
      expect(await snapshotsIn(organization.id, kept.id)).toHaveLength(1);
      expect(logged().filter((entry) => (entry.level as number) >= 40)).toEqual([]);
    });

    it("still deletes when the opamp-server is down, and logs a warning with ids only", async () => {
      const marker = `marker-${randomUUID()}`;
      const { account, organization, access, configuration, version, name } = await withSavedVersion({
        yaml: yamlWith(marker),
      });
      expect((await publish(access, organization.id, configuration.id, version.id)).statusCode).toBe(200);

      expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
      expect((await configurationRow(configuration.id)).deleted_at).toEqual(clock);
      opamp.fake.nextFault("error_500");
      await runner.settle();

      const warnings = logged().filter((entry) => entry.level === 40);
      expect(warnings).toEqual([
        expect.objectContaining({
          msg: "the opamp-server didn't delete the configuration's publications",
          operation: "deleteConfigurationPublications",
          organizationId: organization.id,
          configurationId: configuration.id,
          result: "unavailable",
          reason: "server_error",
          status: 500,
        }),
      ]);
      // The snapshot stays, an orphan, until a reconciliation removes it (not built yet).
      expect(await snapshotsIn(organization.id, configuration.id)).toHaveLength(1);
      expectNotLogged(marker, name, account.user.email, organization.name, FAKE_OPAMP_SERVER_SECRET);
    });

    it("stands when a group is assigned a published version after the usage read: the clean-up keeps the snapshots with a warning naming ids only", async () => {
      const marker = `marker-${randomUUID()}`;
      const { account, organization, access, configuration, version, name } = await withSavedVersion({
        yaml: yamlWith(marker),
      });
      expect((await publish(access, organization.id, configuration.id, version.id)).statusCode).toBe(200);
      const second = await newVersion(access, organization.id, configuration.id, version.id, "exporters: {}\n");
      expect((await publish(access, organization.id, configuration.id, second.id)).statusCode).toBe(200);
      const snapshots = await snapshotIdsIn(organization.id, configuration.id);
      expect(snapshots).toHaveLength(2);
      const { fleetId, defaultGroupId } = await fleetIn(organization.id, account.user.id, account.user.email);

      // The usage is read (nothing uses the configuration), then held until the assignment lands.
      const gate = createGate();
      hooks.getConfigurationUsage = async (...args) => {
        const usage = await opamp.client.getConfigurationUsage(...args);
        await gate.hold();
        return usage;
      };
      const deleting = remove(access, organization.id, configuration.id);
      await gate.reached;
      const publicationId = (await versionRow(version.id)).publication_id!;
      expect(
        (await opamp.client.updateCollectorGroup(organization.id, fleetId, defaultGroupId, { assignedPublicationId: publicationId })).kind,
      ).toBe("updated");
      gate.release();

      // The delete stands: the kept snapshots are an accepted residue.
      expect((await deleting).statusCode).toBe(204);
      expect((await configurationRow(configuration.id)).deleted_at).toEqual(clock);
      await runner.settle();

      expect(logged().filter((entry) => (entry.level as number) >= 40)).toEqual([
        expect.objectContaining({
          level: 40,
          msg: "the opamp-server kept the configuration's publications: a collector group or a collector uses one",
          operation: "deleteConfigurationPublications",
          organizationId: organization.id,
          configurationId: configuration.id,
          result: "in_use",
        }),
      ]);
      // Neither is deleted: the refusal is whole, and the group keeps serving its version.
      expect((await snapshotIdsIn(organization.id, configuration.id)).sort()).toEqual([...snapshots].sort());
      expect(await opamp.client.getCollectorGroup(organization.id, fleetId, defaultGroupId)).toMatchObject({
        kind: "found",
        group: { id: defaultGroupId, assignedPublicationId: publicationId },
      });
      expectNotLogged(marker, name, account.user.email, organization.name, FAKE_OPAMP_SERVER_SECRET);
    });

    it("logs a warning, not an error, when the opamp-server doesn't know the organization", async () => {
      const { organization, access, configuration } = await withSavedVersion();
      expect((await opamp.client.getOrganization(organization.id)).kind).toBe("not_found");

      expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
      await runner.settle();

      expect(logged().filter((entry) => (entry.level as number) >= 40)).toEqual([
        expect.objectContaining({
          level: 40,
          operation: "deleteConfigurationPublications",
          organizationId: organization.id,
          configurationId: configuration.id,
          result: "organization_not_found",
        }),
      ]);
    });

    it("schedules nothing for a refused delete", async () => {
      const creator = await memberActiveInGroup("admin");
      const teammate = await memberActiveInGroup("contributor", creator.group.id);
      const configuration = await created(creator.access, creator.group.id, "Theirs");
      const version = await versionNumbered(configuration.id, 1);
      await saved(creator.access, creator.group.id, configuration.id, version.id, "receivers: {}\n");
      expect((await publish(creator.access, creator.group.id, configuration.id, version.id)).statusCode).toBe(200);
      calls = [];

      expect((await remove(teammate.access, creator.group.id, configuration.id)).statusCode).toBe(403);
      await runner.settle();

      expect(calls).toEqual([]);
      expect(await snapshotsIn(creator.group.id, configuration.id)).toHaveLength(1);
    });
  });

  describe("DELETE …/configurations/:configurationId: refused while a fleet uses it", () => {
    /** A personal user's configuration with version 1 published, and its published copy's id. */
    const withPublished = async () => {
      const saved = await withSavedVersion();
      const { organization, access, configuration, version } = saved;
      expect((await publish(access, organization.id, configuration.id, version.id)).statusCode).toBe(200);
      const publicationId = (await versionRow(version.id)).publication_id!;
      calls = [];
      return { ...saved, publicationId };
    };

    /** Nothing deleted: the configuration live, its snapshots kept, no delete audited, no clean-up queued. */
    const expectNothingDeleted = async (organizationId: string, configurationId: string, snapshots: number) => {
      expect((await configurationRow(configurationId)).deleted_at).toBeNull();
      const deletes = await ownerDb
        .selectFrom("audit_events")
        .select("id")
        .where("action", "=", "configuration.deleted")
        .where("subject_id", "=", configurationId)
        .execute();
      expect(deletes).toEqual([]);
      await runner.settle();
      expect(calls.filter((call) => call.operation === "deleteConfigurationPublications" && call.args[1] === configurationId)).toEqual([]);
      expect(await snapshotsIn(organizationId, configurationId)).toHaveLength(snapshots);
    };

    it("refuses 409 configuration_in_use while a collector group is assigned a published version, then deletes once it isn't", async () => {
      const { account, organization, access, configuration, publicationId } = await withPublished();
      const { fleetId, defaultGroupId } = await fleetIn(organization.id, account.user.id, account.user.email);
      await opamp.client.updateCollectorGroup(organization.id, fleetId, defaultGroupId, { assignedPublicationId: publicationId });

      expectRefusal(await remove(access, organization.id, configuration.id), 409, "configuration_in_use", MESSAGES.inUse);
      expect(operations()).toEqual(["getConfigurationUsage"]);
      await expectNothingDeleted(organization.id, configuration.id, 1);

      await opamp.client.updateCollectorGroup(organization.id, fleetId, defaultGroupId, { assignedPublicationId: null });
      expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
      await runner.settle();
      expect(await snapshotsIn(organization.id, configuration.id)).toEqual([]);
    });

    it("refuses 409 while a collector is pinned to a published version", async () => {
      const { account, organization, access, configuration, publicationId } = await withPublished();
      const { fleetId } = await fleetIn(organization.id, account.user.id, account.user.email);
      const collector = opamp.fake.enrollCollector(organization.id, fleetId);
      const pinned = await opamp.client.updateCollectorInstance(organization.id, fleetId, collector.id, {
        pin: { kind: "publication", id: publicationId },
      });
      expect(pinned.kind).toBe("updated");

      expectRefusal(await remove(access, organization.id, configuration.id), 409, "configuration_in_use", MESSAGES.inUse);
      await expectNothingDeleted(organization.id, configuration.id, 1);
    });

    it("refuses 409 while an archived fleet's group is assigned one, archived fleets counted too", async () => {
      const { account, organization, access, configuration, publicationId } = await withPublished();
      const { fleetId, defaultGroupId } = await fleetIn(organization.id, account.user.id, account.user.email);
      await opamp.client.updateCollectorGroup(organization.id, fleetId, defaultGroupId, { assignedPublicationId: publicationId });
      expect((await opamp.client.updateFleet(organization.id, fleetId, { status: "archived" })).kind).toBe("updated");

      expectRefusal(await remove(access, organization.id, configuration.id), 409, "configuration_in_use", MESSAGES.inUse);
      await expectNothingDeleted(organization.id, configuration.id, 1);
    });

    it("deletes a published configuration no fleet uses, though the organization has fleets", async () => {
      const { account, organization, access, configuration } = await withPublished();
      const { fleetId } = await fleetIn(organization.id, account.user.id, account.user.email);
      opamp.fake.enrollCollector(organization.id, fleetId);

      expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
      expect((await configurationRow(configuration.id)).deleted_at).toEqual(clock);
      await runner.settle();
      expect(operations()).toEqual(["getConfigurationUsage", "deleteConfigurationPublications"]);
    });

    it("deletes one whose organization the opamp-server doesn't know: it holds nothing there, and the delete registers nothing", async () => {
      const { organization, access, configuration } = await withPublished();
      // Gone from the opamp-server (a delete that landed, or a registration never made).
      expect((await opamp.client.deleteOrganization(organization.id)).kind).toBe("deleted");

      expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
      expect(operations()).toEqual(["getConfigurationUsage"]);
      expect((await configurationRow(configuration.id)).deleted_at).toEqual(clock);
      expect(opamp.fake.snapshotOf(organization.id)).toMatchObject({ organization: null });
      await runner.settle();
    });

    it("never asks the opamp-server about a configuration never published", async () => {
      const { organization, access, configuration } = await withSavedVersion();

      expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
      await runner.settle();
      expect(operations()).not.toContain("getConfigurationUsage");
    });

    it("refuses a non-author contributor 403 before asking anything", async () => {
      const creator = await memberActiveInGroup("admin");
      const teammate = await memberActiveInGroup("contributor", creator.group.id);
      const configuration = await created(creator.access, creator.group.id, "Theirs");
      const version = await versionNumbered(configuration.id, 1);
      await saved(creator.access, creator.group.id, configuration.id, version.id, "receivers: {}\n");
      expect((await publish(creator.access, creator.group.id, configuration.id, version.id)).statusCode).toBe(200);
      calls = [];

      expectRefusal(await remove(teammate.access, creator.group.id, configuration.id), 403, "configuration_delete_forbidden", MESSAGES.forbidden);
      expect(calls).toEqual([]);
      await expectNothingDeleted(creator.group.id, configuration.id, 1);
    });

    it.each([
      ["a 500", "error_500", { result: "unavailable", reason: "server_error", status: 500 }],
      ["a reset connection", "reset", { result: "unavailable", reason: "network" }],
      ["a reply the API doesn't document", "malformed_reply", { error: expect.stringContaining("getConfigurationUsage") }],
    ] as const)("refuses 503 fleets_unavailable with the delete's own words on %s, deleting nothing, logging ids only", async (_label, fault, described) => {
      const { account, organization, access, configuration, name } = await withPublished();
      logLines = [];
      opamp.fake.nextFault(fault, "getConfigurationUsage");

      expectRefusal(
        await remove(access, organization.id, configuration.id),
        503,
        "fleets_unavailable",
        FLEETS_UNAVAILABLE_AT_DELETE_MESSAGE,
      );
      if (fault === "malformed_reply") expect(opamp.fake.takeViolations()).toHaveLength(1);
      await expectNothingDeleted(organization.id, configuration.id, 1);
      expect(logged().filter((entry) => entry.operation === "getConfigurationUsage")).toEqual([
        expect.objectContaining({
          level: fault === "malformed_reply" ? 50 : 40,
          organizationId: organization.id,
          configurationId: configuration.id,
          ...described,
        }),
      ]);
      expectNotLogged(name, account.user.email, organization.name, FAKE_OPAMP_SERVER_SECRET, opamp.fake.url, "127.0.0.1:");
    });

    it("refuses 503 when the opamp-server refuses the secret or times out", async () => {
      const { organization, access, configuration } = await withPublished();
      const wrong = createOpampServerClient({ url: opamp.fake.url, secret: "a-wrong-management-secret-0123456789" });
      hooks.getConfigurationUsage = (...args) => wrong.getConfigurationUsage(...args);
      expectRefusal(await remove(access, organization.id, configuration.id), 503, "fleets_unavailable", FLEETS_UNAVAILABLE_AT_DELETE_MESSAGE);
      hooks.getConfigurationUsage = async () => ({ kind: "unavailable", reason: "timeout" });
      expectRefusal(await remove(access, organization.id, configuration.id), 503, "fleets_unavailable", FLEETS_UNAVAILABLE_AT_DELETE_MESSAGE);
      hooks.getConfigurationUsage = async () => {
        throw new OpampServerMisconfigurationError("The opamp-server's reply to getConfigurationUsage (200) named another configuration.");
      };
      expectRefusal(await remove(access, organization.id, configuration.id), 503, "fleets_unavailable", FLEETS_UNAVAILABLE_AT_DELETE_MESSAGE);
      await expectNothingDeleted(organization.id, configuration.id, 1);
      expectNotLogged("a-wrong-management-secret-0123456789", FAKE_OPAMP_SERVER_SECRET);
    });

    it("gives its in-flight slot back however the check ends, and refuses 429 rate_limited, deleting nothing, while 16 of the person's fleet requests are in flight", async () => {
      const { account, organization, access, configuration, publicationId } = await withPublished();
      const { fleetId, defaultGroupId } = await fleetIn(organization.id, account.user.id, account.user.email);
      // Eight checks that end every way, each a slot taken and given back: in use, down, misconfigured, a plain throw.
      await opamp.client.updateCollectorGroup(organization.id, fleetId, defaultGroupId, { assignedPublicationId: publicationId });
      for (let round = 0; round < 2; round++) {
        expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(409);
        opamp.fake.nextFault("error_500", "getConfigurationUsage");
        expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(503);
        hooks.getConfigurationUsage = async () => {
          throw new OpampServerMisconfigurationError("The opamp-server's reply to getConfigurationUsage (200) isn't the API's.");
        };
        expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(503);
        hooks.getConfigurationUsage = async () => {
          throw new Error("a plain failure");
        };
        expectRefusal(await remove(access, organization.id, configuration.id), 503, "fleets_unavailable", FLEETS_UNAVAILABLE_AT_DELETE_MESSAGE);
        delete hooks.getConfigurationUsage;
      }
      await opamp.client.updateCollectorGroup(organization.id, fleetId, defaultGroupId, { assignedPublicationId: null });
      calls = [];
      const gate = createGate();
      let held = 0;
      let heldAll!: () => void;
      const allHeld = new Promise<void>((resolve) => (heldAll = resolve));
      hooks.getFleet = async (...args) => {
        if (++held === 16) heldAll();
        await gate.hold();
        return opamp.client.getFleet(...args);
      };
      const reads = Array.from({ length: 16 }, () =>
        server.inject({
          method: "GET",
          url: `/api/v1/organizations/${organization.id}/fleets/${fleetId}`,
          cookies: { telflo_access: access },
        }),
      );
      try {
        await Promise.race([allHeld, ...reads]);
        expect(held).toBe(16);
        const refused = await remove(access, organization.id, configuration.id);
        expectRefusal(refused, 429, "rate_limited", MESSAGES.rateLimited);
        expect(refused.headers["retry-after"]).toBe("1");
      } finally {
        gate.release();
      }
      expect((await Promise.all(reads)).map((response) => response.statusCode)).toEqual(Array(16).fill(200));
      expect(operations()).not.toContain("getConfigurationUsage");
      await expectNothingDeleted(organization.id, configuration.id, 1);
      // Its slot given back: the delete goes through now.
      expect((await remove(access, organization.id, configuration.id)).statusCode).toBe(204);
    });

    describe("with the person's fleet reads limited", () => {
      let limited: FastifyInstance;

      beforeAll(async () => {
        limited = build({ ...TEST_RATE_LIMITS, fleetReadsPerUser: { max: 2, windowMs: 60_000 } });
        await limited.ready();
      });

      afterAll(async () => {
        await limited.close();
      });

      it("spends a fleet read on a published configuration's delete, refusing it 429 once they are spent, deleting nothing; a draft's spends none", async () => {
        const { account, organization, access } = await personalUser();
        const configurationAt = async (name: string, isPublished: boolean) => {
          const configuration = await created(access, organization.id, name);
          const version = await versionNumbered(configuration.id, 1);
          await saved(access, organization.id, configuration.id, version.id, "receivers: {}\n");
          if (isPublished) expect((await publish(access, organization.id, configuration.id, version.id)).statusCode).toBe(200);
          return configuration;
        };
        const drafts = [await configurationAt("Draft 1", false), await configurationAt("Draft 2", false), await configurationAt("Draft 3", false)];
        const first = await configurationAt("Published 1", true);
        const second = await configurationAt("Published 2", true);
        const { fleetId } = await fleetIn(organization.id, account.user.id, account.user.email);
        calls = [];

        // Drafts spend nothing.
        for (const draft of drafts) expect((await remove(access, organization.id, draft.id, limited)).statusCode).toBe(204);
        // A fleet route's read and a delete's usage check share the count: two in all.
        const fleetRead = await limited.inject({
          method: "GET",
          url: `/api/v1/organizations/${organization.id}/fleets/${fleetId}`,
          cookies: { telflo_access: access },
        });
        expect(fleetRead.statusCode).toBe(200);
        expect((await remove(access, organization.id, first.id, limited)).statusCode).toBe(204);
        const refused = await remove(access, organization.id, second.id, limited);
        expectRefusal(refused, 429, "rate_limited", MESSAGES.rateLimited);
        expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
        expect(calls.filter((call) => call.operation === "getConfigurationUsage").map((call) => call.args[1])).toEqual([first.id]);
        await expectNothingDeleted(organization.id, second.id, 1);
        for (const draft of drafts) expect((await configurationRow(draft.id)).deleted_at).toEqual(clock);
      });
    });
  });
});
