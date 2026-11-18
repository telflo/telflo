import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { parse } from "yaml";
import {
  COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  FLEET_TYPE_NOT_INSTALLABLE_MESSAGE,
  HelmInstallFactsSchema,
  INSTALL_UNAVAILABLE_MESSAGE,
} from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import { addConfiguration, addConfigurationVersion, addMembership, createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { sha256Hex, type OpampServerClient } from "../../opamp-server/client.js";
import { createInstallTemplateLoader, type InstallTemplateLoader } from "../../install/templates.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { hashPassword } from "../identity/password.js";
import type * as CatalogueRepository from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import type * as PublishedVersionRepository from "../configurations/repositories/published-version-repository.js";

/**
 * A test's changes to what the repositories answer (Ruling 47's cases the
 * catalogue the tests share can't hold: another distribution's version, a
 * version without an arch's binaries), cleared before each test.
 */
const overrides = vi.hoisted(() => ({
  distribution: undefined as string | undefined,
  withoutPlatform: undefined as string | undefined,
}));

vi.mock("../configurations/repositories/published-version-repository.js", async (importOriginal) => {
  const original = await importOriginal<typeof PublishedVersionRepository>();
  return {
    ...original,
    createPublishedVersionRepository: (...args: Parameters<typeof original.createPublishedVersionRepository>) => {
      const repository = original.createPublishedVersionRepository(...args);
      return {
        ...repository,
        findForInstall: async (publicationId: string) => {
          const found = await repository.findForInstall(publicationId);
          return found === undefined || overrides.distribution === undefined ? found : { ...found, collectorDistribution: overrides.distribution };
        },
      };
    },
  };
});

vi.mock("../collector-catalogue/repositories/collector-catalogue-repository.js", async (importOriginal) => {
  const original = await importOriginal<typeof CatalogueRepository>();
  return {
    ...original,
    createCollectorCatalogueRepository: (...args: Parameters<typeof original.createCollectorCatalogueRepository>) => {
      const repository = original.createCollectorCatalogueRepository(...args);
      return {
        ...repository,
        findVersionBinaries: async (distribution: string, version: string) => {
          const found = await repository.findVersionBinaries(distribution, version);
          const platform = overrides.withoutPlatform;
          if (found === undefined || platform === undefined) return found;
          const without = (binaries: typeof found.otelcolContrib) => Object.fromEntries(Object.entries(binaries).filter(([key]) => key !== platform));
          return { ...found, otelcolContrib: without(found.otelcolContrib), opampSupervisor: without(found.opampSupervisor) };
        },
      };
    },
  };
});

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
/** Ruling 11's archive check: nothing a placeholder could still be. */
const LEFTOVER = /\$\{[A-Z_][A-Z0-9_]*\}/;

/**
 * The YAML of the published versions: three variables needed, the rest not (a default, reserved, escaped, a
 * name over the facts' 256 characters: once a 500, the reply's schema refusing it).
 */
const YAML = [
  "receivers:",
  "  filelog:",
  "    include: [/var/log/nginx/*.log]",
  "exporters:",
  "  otlphttp:",
  "    endpoint: ${env:BACKEND_ENDPOINT}",
  "    headers:",
  "      x-env: ${env:NGINX_ENV}",
  "      x-key: ${env:BACKEND_API_KEY}",
  "      x-default: ${env:WITH_DEFAULT:-fallback}",
  "      x-reserved: ${env:OPAMP_TOKEN}",
  "      x-escaped: $${env:ESCAPED}",
  `      x-long: \${env:${"L".repeat(257)}}`,
  "",
].join("\n");

/**
 * A Kubernetes group's version (D17d-2 Preflight ruling 4): YAML's
 * variables, the four the chart sets itself, and a YAML 1.1 word (`ON`),
 * which the facts offer like any other (the platform's chart quotes the
 * keys: D18 decision 23).
 */
const KUBERNETES_YAML = [
  YAML.trimEnd(),
  "      x-node: ${env:NODE_NAME}",
  "      x-pod: ${env:POD_NAME}",
  "      x-namespace: ${env:POD_NAMESPACE}",
  "      x-host: ${env:HOST_IP}",
  "      x-word: ${env:ON}",
  "",
].join("\n");

type Method = "GET" | "POST" | "PATCH";

interface Call {
  operation: keyof OpampServerClient;
  args: unknown[];
}

/**
 * D17c-1 decisions 34 to 39 and 47, Preflight rulings 11, 12 and 14: an
 * install's facts and a Linux bundle, against Postgres through the API as
 * its own role, with the OpenAPI-checked fake as the opamp-server and the
 * repository's templates (vitest.setup.ts's TELFLO_INSTALL_TEMPLATES_DIR).
 */
describe("the install routes", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  let logLines: string[] = [];
  let runner: CollectingRunner;
  let calls: Call[] = [];
  let scratch: string;

  const serverClient = new Proxy({} as OpampServerClient, {
    get(_target, property) {
      const operation = property as keyof OpampServerClient;
      return (...args: unknown[]) => {
        calls.push({ operation, args });
        return (opamp.client[operation] as (...given: unknown[]) => Promise<unknown>)(...args);
      };
    },
  });

  function build(installTemplates?: InstallTemplateLoader, rateLimits: RateLimits = TEST_RATE_LIMITS, ownSettings?: AppSettings): FastifyInstance {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    try {
      return buildServer({
        opampServer: serverClient,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: ownSettings ?? settings,
        db,
        mailer: createInMemoryMailer(),
        now: () => clock,
        rateLimits,
        runAfterResponse: (task) => runner.run(task),
        logStream: { write: (line) => void logLines.push(line) },
        ...(installTemplates === undefined ? {} : { installTemplates }),
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
  }

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    server = build();
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
    scratch = await mkdtemp(join(tmpdir(), "install-routes-"));
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    clock = new Date(Math.floor(Date.now() / 1000) * 1000);
    logLines = [];
    runner = createCollectingRunner();
    calls = [];
    overrides.distribution = undefined;
    overrides.withoutPlatform = undefined;
  });

  const operations = () => calls.map((call) => call.operation);
  const logged = () => logLines.map((line) => JSON.parse(line) as Record<string, unknown>);

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message?: string): void {
    expect({ status: response.statusCode, code: response.json<{ error: { code: string } }>().error.code }).toEqual({ status: statusCode, code });
    if (message !== undefined) expect(response.json<{ error: { message: string } }>().error.message).toBe(message);
  }

  function detailPaths(response: LightMyRequestResponse): string[] {
    return (response.json<{ error: { details?: { instancePath: string }[] } }>().error.details ?? []).map((detail) => detail.instancePath);
  }

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

  interface Person {
    userId: string;
    email: string;
    access: string;
  }

  const member = async (role: OrganizationRole, organizationId?: string): Promise<{ organizationId: string; person: Person }> => {
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${Math.random().toString(36).slice(2)}@example.com`, password_hash: passwordHash },
    });
    const { organization } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const signIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
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
    return { organizationId: organization.id, person: { userId: account.user.id, email: account.user.email, access: (switched.headers["set-cookie"] === undefined ? cookieValue(signIn, "telflo_access") : cookieValue(switched, "telflo_access")) } };
  };

  const send = (person: Pick<Person, "access"> | undefined, method: Method, url: string, payload?: unknown, headers = csrfHeaders) =>
    server.inject({
      method,
      url,
      headers,
      ...(person === undefined ? {} : { cookies: { telflo_access: person.access } }),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  const fleetPath = (organizationId: string, fleetId: string) => `/api/v1/organizations/${organizationId}/fleets/${fleetId}`;
  const factsPath = (organizationId: string, fleetId: string, groupId: string) => `${fleetPath(organizationId, fleetId)}/groups/${groupId}/install`;
  const bundlePath = (organizationId: string, fleetId: string, groupId: string) =>
    `${fleetPath(organizationId, fleetId)}/groups/${groupId}/install-bundle`;

  let labels = 0;

  /** A fleet created through the API: its id, its Default group's, its label and its two bearers. */
  const created = async (person: Person, organizationId: string, type = "server") => {
    const label = `edge-prod-${++labels}-${randomUUID()}`;
    const response = await send(person, "POST", `/api/v1/organizations/${organizationId}/fleets`, { label, type, rotateExpiresAt: null });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ fleet: { id: string }; defaultGroup: { id: string }; tokens: { default: { bearer: string }; rotate: { bearer: string } } }>();
    return { fleetId: body.fleet.id, defaultGroupId: body.defaultGroup.id, label, bearers: [body.tokens.default.bearer, body.tokens.rotate.bearer] };
  };

  /** A configuration's version published as D11b leaves one (the platform's rows and the opamp-server's copy). */
  const publishedVersion = async (organizationId: string, creatorUserId: string, collectorVersion = "0.162.0", yaml = YAML) => {
    const configuration = await addConfiguration(ownerDb, { organizationId, created_by_user_id: creatorUserId, name: `nginx-logs-${randomUUID()}` });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId,
      created_by_user_id: creatorUserId,
      version_number: 3,
      yaml_content: yaml,
      collector_distribution: "otelcol-contrib",
      collector_version: collectorVersion,
      publishedAt: new Date(),
      publishedByUserId: creatorUserId,
    });
    const publicationId = version.publication_id as string;
    const result = await opamp.client.postPublication(organizationId, publicationId, {
      configuration: { id: configuration.id, name: configuration.name },
      version: { id: version.id, number: version.version_number, label: null },
      yaml,
      sha256: sha256Hex(yaml),
      publishedBy: null,
      publishedAt: clock.toISOString(),
      collector: { distribution: "otelcol-contrib", version: collectorVersion },
    });
    expect(result.kind).toBe("created");
    return { configurationId: configuration.id, versionId: version.id };
  };

  const MOUNTS = [
    { hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true },
    { hostPath: "/srv/data", containerPath: "/data", readOnly: false },
  ];

  /**
   * A team (an admin and a contributor) with a server fleet, its Default
   * group assigned a published version of v0.162.0 with mounts, and a
   * second group, unassigned.
   */
  const aWorld = async () => {
    const { organizationId, person: admin } = await member("admin");
    const { person: contributor } = await member("contributor", organizationId);
    const fleet = await created(admin, organizationId);
    const published = await publishedVersion(organizationId, admin.userId);
    const assigned = await send(admin, "PATCH", `${fleetPath(organizationId, fleet.fleetId)}/groups/${fleet.defaultGroupId}`, {
      assignedVersionId: published.versionId,
      annotations: { other: { kept: true }, telflo: { dockerMounts: MOUNTS } },
    });
    expect(assigned.statusCode).toBe(200);
    const second = await send(admin, "POST", `${fleetPath(organizationId, fleet.fleetId)}/groups`, { name: `group-${++labels}` });
    expect(second.statusCode).toBe(201);
    calls = [];
    logLines = [];
    return { organizationId, admin, contributor, ...fleet, published, unassignedGroupId: second.json<{ group: { id: string } }>().group.id };
  };

  type World = Awaited<ReturnType<typeof aWorld>>;

  const VOLUMES = [
    { hostPath: "/var/log/app", hostPathType: "Directory", mountPath: "/mnt/app-logs", readOnly: true },
    { hostPath: "/var/lib/buf", hostPathType: "DirectoryOrCreate", mountPath: "/var/lib/buf", readOnly: false },
  ];
  const kubernetesSettings = (role: string, extra: Record<string, unknown> = {}) => ({
    telflo: { kubernetes: { role, namespace: "telflo-collectors", volumes: [], ...extra } },
  });

  /**
   * D17d-2's world: an admin with a Kubernetes-supervisor fleet whose Agent
   * (the Default group, never saved: no settings), Cluster (namespace
   * observability) and gateway traces-sampling (namespace tracing, 3
   * replicas, two volumes) are assigned a published version of v0.162.0
   * reading KUBERNETES_YAML, and a gateway logs-pool, unassigned, with no
   * replicas stored.
   */
  const aKubernetesWorld = async () => {
    const { organizationId, person: admin } = await member("admin");
    const fleet = await created(admin, organizationId, "kubernetes-supervisor");
    const published = await publishedVersion(organizationId, admin.userId, "0.162.0", KUBERNETES_YAML);
    const groups = `${fleetPath(organizationId, fleet.fleetId)}/groups`;
    const group = async (name: string, annotations: Record<string, unknown>) => {
      const response = await send(admin, "POST", groups, { name, annotations });
      expect(response.statusCode).toBe(201);
      return response.json<{ group: { id: string } }>().group.id;
    };
    const assign = async (groupId: string) =>
      expect((await send(admin, "PATCH", `${groups}/${groupId}`, { assignedVersionId: published.versionId })).statusCode).toBe(200);
    const clusterId = await group("cluster", kubernetesSettings("cluster", { namespace: "observability" }));
    const gatewayId = await group("traces-sampling", kubernetesSettings("gateway", { namespace: "tracing", replicas: 3, volumes: VOLUMES }));
    const unassignedGatewayId = await group("logs-pool", kubernetesSettings("gateway"));
    for (const groupId of [fleet.defaultGroupId, clusterId, gatewayId]) await assign(groupId);
    calls = [];
    logLines = [];
    return { organizationId, admin, ...fleet, published, agentId: fleet.defaultGroupId, clusterId, gatewayId, unassignedGatewayId };
  };

  const auditRows = async (organizationId: string) =>
    ownerDb
      .selectFrom("audit_events")
      .select(["action", "subject_type", "subject_id", "metadata", "actor_user_id"])
      .where("organization_id", "=", organizationId)
      .where("action", "like", "fleet.install%")
      .orderBy("id")
      .execute();

  const auditText = async (organizationId: string) =>
    JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().where("organization_id", "=", organizationId).execute());

  /** The archive extracted (tar -xzpf) into its own directory: each file's text and mode. */
  async function extracted(archive: Buffer): Promise<Map<string, { text: string; mode: string }>> {
    const directory = join(scratch, randomUUID());
    await mkdir(directory);
    await writeFile(join(directory, "bundle.tar.gz"), archive);
    const out = join(directory, "out");
    await mkdir(out);
    execFileSync("tar", ["-xzpf", join(directory, "bundle.tar.gz"), "-C", out]);
    const files = new Map<string, { text: string; mode: string }>();
    for (const name of (await readdir(out)).sort()) {
      files.set(name, { text: await readFile(join(out, name), "utf8"), mode: ((await stat(join(out, name))).mode & 0o777).toString(8) });
    }
    return files;
  }

  const allInOne = (overrides: Record<string, unknown> = {}) => ({
    method: "all-in-one",
    arch: "amd64",
    rootPath: "/etc/otelcol/",
    env: [{ name: "NGINX_ENV", value: "prod" }],
    ...overrides,
  });

  // -------------------------------------------------------------------------

  describe("the install's facts (decision 38)", () => {
    it.each(["admin", "contributor"] as const)("answers a %s the image, endpoint, collector, variables and mounts, no-store and no bearer", async (role) => {
      const world = await aWorld();
      const response = await send(world[role], "GET", factsPath(world.organizationId, world.fleetId, world.defaultGroupId));
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        imageTag: "ghcr.io/telflo/telflo/collector:0.162.0",
        endpoint: "https://opamp-agent-placeholder.invalid/v1/opamp",
        allowInsecureConnections: false,
        collector: { distribution: "otelcol-contrib", version: "0.162.0" },
        envVarNames: ["BACKEND_ENDPOINT", "NGINX_ENV", "BACKEND_API_KEY"],
        mounts: MOUNTS,
        mountsReadable: true,
        groupId: world.defaultGroupId,
      });
      for (const bearer of world.bearers) expect(response.body).not.toContain(bearer);
      expect(operations()).toEqual(["getFleet", "getCollectorGroup"]);
    });

    it("reads a non-Default group's own version, and its mounts (none)", async () => {
      const world = await aWorld();
      const published = await publishedVersion(world.organizationId, world.admin.userId, "0.160.0");
      await send(world.admin, "PATCH", `${fleetPath(world.organizationId, world.fleetId)}/groups/${world.unassignedGroupId}`, {
        assignedVersionId: published.versionId,
      });
      const response = await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, world.unassignedGroupId));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        imageTag: "ghcr.io/telflo/telflo/collector:0.160.0",
        mounts: [],
        mountsReadable: true,
        groupId: world.unassignedGroupId,
      });
    });

    it("says when the group's mounts can't be read (Ruling 62): another client's \"telflo\" shape is no mounts, and mountsReadable false", async () => {
      const world = await aWorld();
      // Written to the opamp-server directly: the platform's own write refuses a "telflo" it can't read.
      const written = await opamp.client.updateCollectorGroup(world.organizationId, world.fleetId, world.defaultGroupId, {
        annotations: { other: { kept: true }, telflo: { dockerMounts: "theirs" } },
      });
      expect(written.kind).toBe("updated");
      const response = await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, world.defaultGroupId));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ mounts: [], mountsReadable: false, groupId: world.defaultGroupId });
    });

    // A Kubernetes-supervisor fleet's group answers its Helm facts (D17d-2 Preflight ruling 5): below.
    it("refuses, in ruling 14's order: an unknown fleet, an archived one", async () => {
      const world = await aWorld();
      expectRefusal(await send(world.admin, "GET", factsPath(world.organizationId, randomUUID(), world.defaultGroupId)), 404, "fleet_not_found");
      calls = [];
      expectRefusal(await send(world.admin, "GET", factsPath(world.organizationId, "not-a-uuid", world.defaultGroupId)), 404, "fleet_not_found");
      expectRefusal(await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, "not-a-uuid")), 404, "collector_group_not_found");
      expect(operations()).toEqual([]);

      expect((await send(world.admin, "PATCH", fleetPath(world.organizationId, world.fleetId), { status: "archived" })).statusCode).toBe(200);
      // Archived before the group is read: even an unknown group answers fleet_archived.
      expectRefusal(await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, randomUUID())), 409, "fleet_archived");
    });

    it("refuses an unknown group, another fleet's, an unassigned one, a deleted configuration's version and a retired version", async () => {
      const world = await aWorld();
      expectRefusal(await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, randomUUID())), 404, "collector_group_not_found");
      const another = await created(world.admin, world.organizationId);
      expectRefusal(await send(world.admin, "GET", factsPath(world.organizationId, another.fleetId, world.defaultGroupId)), 404, "collector_group_not_found");
      expectRefusal(
        await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, world.unassignedGroupId)),
        409,
        "collector_group_unassigned",
        "Assign a published version to this group first: its collector version picks what to install.",
      );

      const retired = await publishedVersion(world.organizationId, world.admin.userId, "0.158.0");
      await send(world.admin, "PATCH", `${fleetPath(world.organizationId, world.fleetId)}/groups/${world.unassignedGroupId}`, { assignedVersionId: retired.versionId });
      expectRefusal(
        await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, world.unassignedGroupId)),
        409,
        "collector_version_not_offered",
        "Collector v0.158.0 is no longer offered. Publish a version that uses an offered collector, then assign it.",
      );

      await ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", world.published.configurationId).execute();
      expectRefusal(
        await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, world.defaultGroupId)),
        409,
        "collector_group_assignment_deleted",
        "This group's published version belongs to a deleted configuration. Assign another first.",
      );
    });

    it("isolation: another organization's fleet and group are as absent as unknown ones, through either organization's path", async () => {
      const world = await aWorld();
      const { organizationId: otherOrganization, person: stranger } = await member("admin");
      const theirs = await created(stranger, otherOrganization);
      calls = [];
      // The path naming the other organization: refused before any call.
      const throughTheirs = await send(stranger, "GET", factsPath(world.organizationId, world.fleetId, world.defaultGroupId));
      expectRefusal(throughTheirs, 404, "organization_not_found");
      expect(operations()).toEqual([]);
      // Their own organization's path, naming this organization's fleet or group.
      expectRefusal(await send(stranger, "GET", factsPath(otherOrganization, world.fleetId, world.defaultGroupId)), 404, "fleet_not_found");
      expectRefusal(await send(stranger, "GET", factsPath(otherOrganization, theirs.fleetId, world.defaultGroupId)), 404, "collector_group_not_found");
      for (const response of [throughTheirs]) expect(response.body).not.toContain("NGINX_ENV");
      expect(calls.every((call) => call.args[0] === otherOrganization)).toBe(true);
    });

    it("needs a session", async () => {
      const world = await aWorld();
      expectRefusal(await send(undefined, "GET", factsPath(world.organizationId, world.fleetId, world.defaultGroupId)), 401, "unauthenticated");
    });

    it("logs no variable's name, mount path or the YAML", async () => {
      const world = await aWorld();
      expect((await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, world.defaultGroupId))).statusCode).toBe(200);
      expect(logLines.length).toBeGreaterThan(0);
      for (const value of ["NGINX_ENV", "BACKEND_API_KEY", "/var/log/nginx", "/srv/data", "filelog"]) {
        expect(logLines.filter((line) => line.includes(value))).toEqual([]);
      }
    });
  });

  // -------------------------------------------------------------------------

  describe("a Kubernetes group's Helm facts (D17d-2 decision 15; Preflight rulings 1 to 5)", () => {
    // D18 decisions 9 and 10: the platform's own chart and image, the settings' defaults.
    const CHART = { chartReference: "oci://ghcr.io/telflo/telflo/charts/supervisor-collector", chartVersion: "0.1.0", imageRepository: "ghcr.io/telflo/telflo/collector" };
    const SERVER_FACTS = {
      imageTag: "ghcr.io/telflo/telflo/collector:0.162.0",
      endpoint: "https://opamp-agent-placeholder.invalid/v1/opamp",
      allowInsecureConnections: false,
      collector: { distribution: "otelcol-contrib", version: "0.162.0" },
      envVarNames: ["BACKEND_ENDPOINT", "NGINX_ENV", "BACKEND_API_KEY", "ON"],
    };

    it("answers a Kubernetes group's Helm facts: the Agent before its first save (telflo-collectors, no volumes), the Cluster, a gateway with replicas and volumes, the chart settings, the fleet's fullnameOverride (D18), no-store, no bearer", async () => {
      const world = await aKubernetesWorld();
      const facts = async (groupId: string, on = server) => {
        const response = await on.inject({
          method: "GET",
          url: factsPath(world.organizationId, world.fleetId, groupId),
          cookies: { telflo_access: world.admin.access },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        for (const bearer of world.bearers) expect(response.body).not.toContain(bearer);
        // Strict: no mounts, no mountsReadable.
        expect(HelmInstallFactsSchema.safeParse(response.json()).success).toBe(true);
        return response.json();
      };

      expect(await facts(world.agentId)).toEqual({
        ...SERVER_FACTS,
        groupId: world.agentId,
        // D18 Preflight ruling 10: the override checked against THIS fleet's id (the facts carry none).
        helm: { ...CHART, release: "telflo-node", fullnameOverride: `${world.fleetId.slice(0, 8)}-default`, role: "node", namespace: "telflo-collectors", replicas: null, volumes: [] },
      });
      expect(operations()).toEqual(["getFleet", "getCollectorGroup"]);
      expect(await facts(world.clusterId)).toEqual({
        ...SERVER_FACTS,
        groupId: world.clusterId,
        helm: { ...CHART, release: "telflo-cluster", fullnameOverride: `${world.fleetId.slice(0, 8)}-cluster`, role: "cluster", namespace: "observability", replicas: null, volumes: [] },
      });
      expect(await facts(world.gatewayId)).toEqual({
        ...SERVER_FACTS,
        groupId: world.gatewayId,
        helm: { ...CHART, release: "traces-sampling", fullnameOverride: null, role: "gateway", namespace: "tracing", replicas: 3, volumes: VOLUMES },
      });
      // A gateway whose settings store no replicas installs one.
      const published = await publishedVersion(world.organizationId, world.admin.userId, "0.160.0", KUBERNETES_YAML);
      await send(world.admin, "PATCH", `${fleetPath(world.organizationId, world.fleetId)}/groups/${world.unassignedGatewayId}`, { assignedVersionId: published.versionId });
      expect(await facts(world.unassignedGatewayId)).toMatchObject({
        imageTag: "ghcr.io/telflo/telflo/collector:0.160.0",
        collector: { distribution: "otelcol-contrib", version: "0.160.0" },
        helm: { release: "logs-pool", fullnameOverride: null, role: "gateway", namespace: "telflo-collectors", replicas: 1, volumes: [] },
      });

      // The chart settings, a mirror's (TELFLO_HELM_CHART_REFERENCE, TELFLO_HELM_CHART_VERSION).
      const mirrored = build(undefined, TEST_RATE_LIMITS, {
        ...settings,
        install: { ...settings.install, helmChartReference: "oci://registry.example:5000/mirror/charts/x", helmChartVersion: "1.2.3" },
      });
      await mirrored.ready();
      try {
        expect((await facts(world.agentId, mirrored)).helm).toMatchObject({ chartReference: "oci://registry.example:5000/mirror/charts/x", chartVersion: "1.2.3" });
      } finally {
        await mirrored.close();
      }

      // The refusals the server facts make, the group's own: an unknown group, an unassigned one, an archived fleet.
      expectRefusal(await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, randomUUID())), 404, "collector_group_not_found");
      const unassigned = await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/groups`, {
        name: "spare",
        annotations: kubernetesSettings("gateway"),
      });
      expectRefusal(
        await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, unassigned.json<{ group: { id: string } }>().group.id)),
        409,
        "collector_group_unassigned",
      );
      expect((await send(world.admin, "PATCH", fleetPath(world.organizationId, world.fleetId), { status: "archived" })).statusCode).toBe(200);
      expectRefusal(await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, world.agentId)), 409, "fleet_archived");
    });

    // D18 decision 21; Preflight rulings 10 to 12: two fleets' Agents and Clusters share a cluster under their own names.
    it("names each fleet's Agent and Cluster by that fleet's id, never another's (fullnameOverride), and no gateway", async () => {
      const overrides = async (world: Awaited<ReturnType<typeof aKubernetesWorld>>) => {
        const of = async (groupId: string) => {
          const response = await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, groupId));
          expect(response.statusCode).toBe(200);
          return response.json<{ helm: { fullnameOverride: string | null } }>().helm.fullnameOverride;
        };
        return [await of(world.agentId), await of(world.clusterId), await of(world.gatewayId)];
      };
      const first = await aKubernetesWorld();
      const second = await aKubernetesWorld();
      expect(first.fleetId).toMatch(/^[0-9a-f]{8}-/);
      expect(await overrides(first)).toEqual([`${first.fleetId.slice(0, 8)}-default`, `${first.fleetId.slice(0, 8)}-cluster`, null]);
      expect(await overrides(second)).toEqual([`${second.fleetId.slice(0, 8)}-default`, `${second.fleetId.slice(0, 8)}-cluster`, null]);
      expect(first.fleetId.slice(0, 8)).not.toBe(second.fleetId.slice(0, 8));
    });

    it("a Kubernetes group whose settings can't be read is 409 collector_group_settings_unreadable", async () => {
      const world = await aKubernetesWorld();
      // Written to the opamp-server directly: the platform's own writes refuse each of these.
      const written = async (groupId: string, annotations: Record<string, unknown> | null) =>
        expect((await opamp.client.updateCollectorGroup(world.organizationId, world.fleetId, groupId, { annotations })).kind).toBe("updated");
      const refused = async (groupId: string) => {
        const response = await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, groupId));
        expectRefusal(response, 409, "collector_group_settings_unreadable", COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE);
        for (const text of ["observability", "tracing", "traces-sampling", "theirs"]) expect(response.body).not.toContain(text);
      };

      // Another client's "telflo" shape, and settings that aren't the platform's.
      await written(world.agentId, { telflo: "theirs" });
      await refused(world.agentId);
      await written(world.agentId, { telflo: { kubernetes: { role: "node", namespace: "Not A Namespace", volumes: [] } } });
      await refused(world.agentId);
      // A stored role that isn't the group's (the Agent's says gateway; the gateway's says cluster).
      await written(world.agentId, kubernetesSettings("gateway"));
      await refused(world.agentId);
      await written(world.gatewayId, kubernetesSettings("cluster", { namespace: "tracing" }));
      await refused(world.gatewayId);
      // A Cluster and a gateway without settings (only the Agent installs with the defaults).
      await written(world.clusterId, { other: { kept: true } });
      await refused(world.clusterId);
      await written(world.gatewayId, null);
      await refused(world.gatewayId);
      // Saved again, each installs.
      await written(world.agentId, null);
      expect((await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, world.agentId))).statusCode).toBe(200);
    });

    it("a Kubernetes group's facts leave out the variables the chart sets", async () => {
      const world = await aKubernetesWorld();
      const response = await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, world.gatewayId));
      expect(response.statusCode).toBe(200);
      // POD_NAMESPACE, POD_NAME, NODE_NAME and HOST_IP are the chart's own (its env beats envFrom); a YAML word is
      // offered like any other (D18 decision 23); the reserved and the defaulted as a server group's.
      expect(response.json<{ envVarNames: string[] }>().envVarNames).toEqual(["BACKEND_ENDPOINT", "NGINX_ENV", "BACKEND_API_KEY", "ON"]);
      // A server group of the same version offers them all (the chart's names are only a Helm install's).
      const serverWorld = await aWorld();
      const published = await publishedVersion(serverWorld.organizationId, serverWorld.admin.userId, "0.162.0", KUBERNETES_YAML);
      await send(serverWorld.admin, "PATCH", `${fleetPath(serverWorld.organizationId, serverWorld.fleetId)}/groups/${serverWorld.defaultGroupId}`, {
        assignedVersionId: published.versionId,
      });
      expect(
        (await send(serverWorld.admin, "GET", factsPath(serverWorld.organizationId, serverWorld.fleetId, serverWorld.defaultGroupId))).json<{ envVarNames: string[] }>()
          .envVarNames,
      ).toEqual(["BACKEND_ENDPOINT", "NGINX_ENV", "BACKEND_API_KEY", "NODE_NAME", "POD_NAME", "POD_NAMESPACE", "HOST_IP", "ON"]);
    });

    it("the Linux bundle refuses a Kubernetes fleet with the Kubernetes direction's words", async () => {
      const world = await aKubernetesWorld();
      for (const groupId of [world.agentId, world.clusterId, world.gatewayId]) {
        calls = [];
        expectRefusal(
          await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, groupId), allInOne()),
          409,
          "fleet_type_not_installable",
          FLEET_TYPE_NOT_INSTALLABLE_MESSAGE,
        );
        // Refused by the fleet's type, before the group is read.
        expect(operations()).toEqual(["getFleet"]);
      }
      expect(await auditRows(world.organizationId)).toEqual([]);
    });
  });

  describe("the Linux bundle (decision 39)", () => {
    it("All In One: a gzipped tar named by the method and arch, no-store, nosniff; its files and modes; no bearer, label or placeholder left", async () => {
      const world = await aWorld();
      const response = await send(world.contributor, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), allInOne());
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("application/gzip");
      expect(response.headers["content-disposition"]).toBe('attachment; filename="telflo-collector-all-in-one-amd64.tar.gz"');
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      const files = await extracted(response.rawPayload);
      expect([...files].map(([name, file]) => [name, file.mode])).toEqual([
        ["README.md", "644"],
        ["otelcol-config.yaml", "644"],
        ["start_supervisor.sh", "700"],
        ["supervisor-config.yaml", "644"],
      ]);
      for (const [name, file] of files) {
        expect({ name, leftover: LEFTOVER.exec(file.text)?.[0] ?? null }).toEqual({ name, leftover: null });
        for (const secret of [...world.bearers, world.label]) expect(file.text).not.toContain(secret);
      }
      const script = files.get("start_supervisor.sh")!.text;
      expect(script).toContain("root_path='/etc/otelcol'\n");
      expect(script).toContain("export NGINX_ENV='prod'\n");
      expect(script).toContain("otelcol_version='0.162.0'\n");
      expect(script).toMatch(/otelcol_contrib_url='https:\/\/github\.com\/open-telemetry\/opentelemetry-collector-releases\/releases\/download\/v0\.162\.0\/otelcol-contrib_0\.162\.0_linux_amd64\.tar\.gz'\n/);
      const config = parse(files.get("supervisor-config.yaml")!.text);
      expect(config.server.endpoint).toBe("https://opamp-agent-placeholder.invalid/v1/opamp");
      expect(config.server.tls).toEqual({ insecure_skip_verify: false, insecure: false });
      expect(config.agent.description.non_identifying_attributes["telflo.collector_group_id"]).toBe(world.defaultGroupId);
      expect(config.agent.executable).toBe("/etc/otelcol/otelcol-contrib");
      expect(operations()).toEqual(["getFleet", "getCollectorGroup"]);
    });

    it("own-binary, arm64: the host's collector, and a supervisor for each offered version", async () => {
      const world = await aWorld();
      const response = await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), {
        method: "own-binary",
        arch: "arm64",
        rootPath: "/srv/otel",
        executablePath: "/opt/bin/otelcol-contrib",
        env: [],
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toBe('attachment; filename="telflo-collector-own-binary-arm64.tar.gz"');
      const files = await extracted(response.rawPayload);
      const script = files.get("start_supervisor.sh")!.text;
      expect(script).toContain("executable_path='/opt/bin/otelcol-contrib'\n");
      for (const version of ["0.162.0", "0.161.0", "0.160.0", "0.159.0"]) {
        expect(script).toContain(`  '${version}')\n    sup_ver='${version}'\n    sup_url='https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/cmd%2Fopampsupervisor%2Fv${version}/opampsupervisor_${version}_linux_arm64'\n`);
      }
      // A retired version has no arm of its own.
      expect(script).not.toContain("'0.158.0')");
      const config = parse(files.get("supervisor-config.yaml")!.text);
      expect([config.agent.executable, config.agent.config_files, config.storage.directory]).toEqual([
        "/opt/bin/otelcol-contrib",
        ["/srv/otel/otelcol-config.yaml"],
        "/srv/otel/opamp",
      ]);
      expect(files.get("README.md")!.text).toContain("(linux arm64)");
    });

    it("audits fleet.install_bundle_downloaded with ids, the method and the arch only", async () => {
      const world = await aWorld();
      const rootPath = "/opt/root-path-canary";
      const value = "env-value-canary-5b1e";
      const response = await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), allInOne({
        rootPath,
        env: [{ name: "BACKEND_API_KEY", value }],
      }));
      expect(response.statusCode).toBe(200);
      expect(await auditRows(world.organizationId)).toEqual([
        {
          action: "fleet.install_bundle_downloaded",
          subject_type: "fleet",
          subject_id: world.fleetId,
          actor_user_id: world.admin.userId,
          metadata: { fleetId: world.fleetId, groupId: world.defaultGroupId, method: "all-in-one", arch: "amd64" },
        },
      ]);
      const text = await auditText(world.organizationId);
      for (const secret of [rootPath, value, "BACKEND_API_KEY", world.label]) expect(text).not.toContain(secret);
    });

    it("privacy: no body value reaches a log line, the request's own line included (it keeps the path's ids)", async () => {
      const world = await aWorld();
      const canaries = ["/opt/privacy-root-canary", "privacy-value-canary-c0de", "/opt/privacy-executable-canary"];
      const response = await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), {
        method: "own-binary",
        arch: "amd64",
        rootPath: canaries[0],
        executablePath: canaries[2],
        env: [{ name: "NGINX_ENV", value: canaries[1] }],
      });
      expect(response.statusCode).toBe(200);
      const requestLines = logged().filter((line) => typeof line.req === "object" || typeof line.url === "string");
      expect(requestLines.length).toBeGreaterThan(0);
      expect(logLines.some((line) => line.includes(world.defaultGroupId))).toBe(true);
      for (const canary of [...canaries, "NGINX_ENV"]) expect(logLines.filter((line) => line.includes(canary))).toEqual([]);
      // A refused body too: the 400's details name fields, never their values.
      logLines = [];
      const refused = await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), allInOne({
        rootPath: "/opt/refused canary",
        env: [{ name: "NOT_OFFERED_CANARY", value: "x" }],
      }));
      expect(refused.statusCode).toBe(400);
      for (const canary of ["refused canary", "NOT_OFFERED_CANARY"]) {
        expect(logLines.filter((line) => line.includes(canary))).toEqual([]);
        expect(refused.body).not.toContain(canary);
      }
    });

    it("refuses each invalid field with invalid_request, naming it, with no call", async () => {
      const world = await aWorld();
      const path = bundlePath(world.organizationId, world.fleetId, world.defaultGroupId);
      const cases: [Record<string, unknown>, string][] = [
        [allInOne({ method: "container" }), "/method"],
        [allInOne({ arch: "386" }), "/arch"],
        [allInOne({ rootPath: "etc/otelcol" }), "/rootPath"],
        [allInOne({ rootPath: "/etc/otel col" }), "/rootPath"],
        [allInOne({ rootPath: "/etc/../tmp" }), "/rootPath"],
        [allInOne({ rootPath: "/etc/otel'col" }), "/rootPath"],
        [allInOne({ rootPath: "/" }), "/rootPath"],
        [allInOne({ executablePath: "/usr/bin/otelcol-contrib" }), "/executablePath"],
        [allInOne({ method: "own-binary" }), "/executablePath"],
        [allInOne({ env: [{ name: "NGINX_ENV", value: "" }] }), "/env/0/value"],
        [allInOne({ env: [{ name: "NGINX_ENV", value: "a\nb" }] }), "/env/0/value"],
        [allInOne({ env: [{ name: "BAD-NAME", value: "x" }] }), "/env/0/name"],
        [allInOne({ extra: true }), ""],
      ];
      for (const [body, field] of cases) {
        const response = await send(world.admin, "POST", path, body);
        expect({ field, status: response.statusCode, code: response.json<{ error: { code: string } }>().error.code }).toEqual({
          field,
          status: 400,
          code: "invalid_request",
        });
        if (field !== "") expect(detailPaths(response)).toContain(field);
      }
      expect(operations()).toEqual([]);
    });

    it("refuses a variable the facts don't offer (a default's, a reserved one, an unknown one), naming each index", async () => {
      const world = await aWorld();
      const response = await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), allInOne({
        env: [
          { name: "NGINX_ENV", value: "prod" },
          { name: "OPAMP_TOKEN", value: "x" },
          { name: "WITH_DEFAULT", value: "x" },
          { name: "ESCAPED", value: "x" },
          { name: "LD_PRELOAD", value: "x" },
        ],
      }));
      expectRefusal(response, 400, "invalid_request", "Only the variables this group's published version reads can be set.");
      expect(detailPaths(response)).toEqual(["/env/1/name", "/env/2/name", "/env/3/name", "/env/4/name"]);
      expect(await auditRows(world.organizationId)).toEqual([]);
    });

    it("refuses as the facts do: archived, unassigned, another organization's", async () => {
      const world = await aWorld();
      expectRefusal(await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.unassignedGroupId), allInOne()), 409, "collector_group_unassigned");
      const { organizationId: otherOrganization, person: stranger } = await member("admin");
      expectRefusal(await send(stranger, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), allInOne()), 404, "organization_not_found");
      expectRefusal(await send(stranger, "POST", bundlePath(otherOrganization, world.fleetId, world.defaultGroupId), allInOne()), 404, "fleet_not_found");
      await send(world.admin, "PATCH", fleetPath(world.organizationId, world.fleetId), { status: "archived" });
      expectRefusal(await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), allInOne()), 409, "fleet_archived");
      expect(await auditRows(world.organizationId)).toEqual([]);
    });

    it("needs the CSRF header and a session", async () => {
      const world = await aWorld();
      const path = bundlePath(world.organizationId, world.fleetId, world.defaultGroupId);
      expect((await send(world.admin, "POST", path, allInOne(), {} as typeof csrfHeaders)).statusCode).toBe(403);
      expectRefusal(await send(undefined, "POST", path, allInOne()), 401, "unauthenticated");
      expect(operations()).toEqual([]);
    });

    it("answers 503 install_unavailable when the templates can't be used, logging the method and the file, never the text", async () => {
      const world = await aWorld();
      const broken = join(scratch, `broken-${randomUUID()}`);
      await mkdir(join(broken, "linux", "all-in-one"), { recursive: true });
      await writeFile(join(broken, "linux", "all-in-one", "README.md"), "template-text-canary-ab12 ${NOT_KNOWN}\n");
      const brokenServer = build(createInstallTemplateLoader(broken));
      try {
        await brokenServer.ready();
        const response = await brokenServer.inject({
          method: "POST",
          url: bundlePath(world.organizationId, world.fleetId, world.defaultGroupId),
          headers: csrfHeaders,
          cookies: { telflo_access: world.admin.access },
          payload: allInOne(),
        });
        expectRefusal(response, 503, "install_unavailable", INSTALL_UNAVAILABLE_MESSAGE);
        expect(logged().filter((line) => line.msg === "installing failed: the install templates can't be used")).toEqual([
          expect.objectContaining({
            operation: "installBundle",
            organizationId: world.organizationId,
            fleetId: world.fleetId,
            groupId: world.defaultGroupId,
            method: "all-in-one",
            file: "linux/all-in-one/README.md",
            reason: "line 1: a placeholder Telflo doesn't fill",
          }),
        ]);
        expect(logLines.filter((line) => line.includes("template-text-canary-ab12"))).toEqual([]);
        expect(await auditRows(world.organizationId)).toEqual([]);
        // A missing own-binary set alike.
        const ownBinary = await brokenServer.inject({
          method: "POST",
          url: bundlePath(world.organizationId, world.fleetId, world.defaultGroupId),
          headers: csrfHeaders,
          cookies: { telflo_access: world.admin.access },
          payload: { method: "own-binary", arch: "amd64", rootPath: "/etc/otelcol", executablePath: "/usr/bin/otelcol-contrib", env: [] },
        });
        expectRefusal(ownBinary, 503, "install_unavailable");
      } finally {
        await brokenServer.close();
      }
    });

    it("reads the templates again on every render: an edit applies at the next bundle", async () => {
      const world: World = await aWorld();
      const live = join(scratch, `live-${randomUUID()}`);
      execFileSync("cp", ["-R", settings.install.templatesDirectory, live]);
      const liveServer = build(createInstallTemplateLoader(live));
      try {
        await liveServer.ready();
        const download = async () =>
          extracted(
            (
              await liveServer.inject({
                method: "POST",
                url: bundlePath(world.organizationId, world.fleetId, world.defaultGroupId),
                headers: csrfHeaders,
                cookies: { telflo_access: world.admin.access },
                payload: allInOne(),
              })
            ).rawPayload,
          );
        expect((await download()).get("README.md")!.text).not.toContain("edited by the operator");
        await writeFile(join(live, "linux", "all-in-one", "README.md"), "edited by the operator for ${ARCH}\n");
        expect((await download()).get("README.md")!.text).toBe("edited by the operator for amd64\n");
      } finally {
        await liveServer.close();
      }
    });

    it("sends its length (content-length)", async () => {
      const world = await aWorld();
      const response = await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), allInOne());
      expect(response.statusCode).toBe(200);
      expect(Number(response.headers["content-length"])).toBe(response.rawPayload.length);
    });

    it("refuses a variable named twice at its second, \"Each variable once.\"", async () => {
      const world = await aWorld();
      const response = await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), allInOne({
        env: [{ name: "NGINX_ENV", value: "a" }, { name: "NGINX_ENV", value: "b" }],
      }));
      expectRefusal(response, 400, "invalid_request");
      const details = response.json<{ error: { details: { instancePath: string; message: string }[] } }>().error.details;
      expect(details.map(({ instancePath, message }) => [instancePath, message])).toEqual([["/env/1/name", "Each variable once."]]);
      expect(operations()).toEqual([]);
    });

    it("refuses as the facts do: a Kubernetes-supervisor fleet, a retired version, a deleted configuration's", async () => {
      const world = await aWorld();
      const kubernetes = await created(world.admin, world.organizationId, "kubernetes-supervisor");
      expectRefusal(
        await send(world.admin, "POST", bundlePath(world.organizationId, kubernetes.fleetId, kubernetes.defaultGroupId), allInOne()),
        409,
        "fleet_type_not_installable",
      );
      const retired = await publishedVersion(world.organizationId, world.admin.userId, "0.158.0");
      await send(world.admin, "PATCH", `${fleetPath(world.organizationId, world.fleetId)}/groups/${world.unassignedGroupId}`, { assignedVersionId: retired.versionId });
      expectRefusal(
        await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.unassignedGroupId), allInOne()),
        409,
        "collector_version_not_offered",
        "Collector v0.158.0 is no longer offered. Publish a version that uses an offered collector, then assign it.",
      );
      await ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", world.published.configurationId).execute();
      expectRefusal(
        await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), allInOne()),
        409,
        "collector_group_assignment_deleted",
      );
      expect(await auditRows(world.organizationId)).toEqual([]);
    });

    it("refuses another distribution's version (the image and the bundles are otelcol-contrib's), facts and bundle alike: Ruling 47", async () => {
      const world = await aWorld();
      overrides.distribution = "probe-distribution";
      const message = "Collector distribution probe-distribution can't be installed here. Publish a version built for otelcol-contrib, then assign it.";
      expectRefusal(await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, world.defaultGroupId)), 409, "collector_version_not_offered", message);
      expectRefusal(
        await send(world.admin, "POST", bundlePath(world.organizationId, world.fleetId, world.defaultGroupId), allInOne()),
        409,
        "collector_version_not_offered",
        message,
      );
      expect(await auditRows(world.organizationId)).toEqual([]);
    });

    it("refuses an arch the catalogue has no binaries of, before rendering, and takes the other: Ruling 47", async () => {
      const world = await aWorld();
      overrides.withoutPlatform = "linux_arm64";
      const path = bundlePath(world.organizationId, world.fleetId, world.defaultGroupId);
      for (const body of [allInOne({ arch: "arm64" }), { method: "own-binary", arch: "arm64", rootPath: "/etc/otelcol", executablePath: "/usr/bin/otelcol-contrib", env: [] }]) {
        expectRefusal(
          await send(world.admin, "POST", path, body),
          409,
          "collector_version_not_offered",
          "Collector v0.162.0 has no arm64 binaries to install. Choose the other arch, or publish a version that has them.",
        );
      }
      expect(logged().filter((line) => (line.level as number) >= 50)).toEqual([]);
      expect((await send(world.admin, "POST", path, allInOne({ arch: "amd64" }))).statusCode).toBe(200);
      // The container install needs no binaries: its facts answer.
      expect((await send(world.admin, "GET", factsPath(world.organizationId, world.fleetId, world.defaultGroupId))).statusCode).toBe(200);
    });

    it("spends a read on the facts and a write on the bundle (Preflight ruling 14)", async () => {
      const world = await aWorld();
      const go = (on: FastifyInstance, method: "GET" | "POST", url: string, payload?: unknown) =>
        on.inject({ method, url, headers: csrfHeaders, cookies: { telflo_access: world.admin.access }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
      const facts = factsPath(world.organizationId, world.fleetId, world.defaultGroupId);
      const bundle = bundlePath(world.organizationId, world.fleetId, world.defaultGroupId);
      const oneRead = build(undefined, { ...TEST_RATE_LIMITS, fleetReadsPerUser: { ...TEST_RATE_LIMITS.fleetReadsPerUser, max: 1 } });
      const oneWrite = build(undefined, { ...TEST_RATE_LIMITS, fleetWritesPerUser: { ...TEST_RATE_LIMITS.fleetWritesPerUser, max: 1 } });
      try {
        await oneRead.ready();
        await oneWrite.ready();
        expect((await go(oneRead, "GET", facts)).statusCode).toBe(200);
        expectRefusal(await go(oneRead, "GET", facts), 429, "rate_limited");
        expect((await go(oneRead, "POST", bundle, allInOne())).statusCode).toBe(200);
        expect((await go(oneWrite, "POST", bundle, allInOne())).statusCode).toBe(200);
        expectRefusal(await go(oneWrite, "POST", bundle, allInOne()), 429, "rate_limited");
        expect((await go(oneWrite, "GET", facts)).statusCode).toBe(200);
      } finally {
        await oneRead.close();
        await oneWrite.close();
      }
    });
  });
});
