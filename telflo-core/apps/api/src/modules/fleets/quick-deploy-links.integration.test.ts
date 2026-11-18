import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import {
  COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE,
  FLEET_TYPE_NOT_INSTALLABLE_MESSAGE,
  HELM_CHART_ENV_NAME_MESSAGE,
  HELM_CHART_ENV_NAMES,
  QUICK_DEPLOY_LINK_ERROR_MESSAGES,
  QUICK_DEPLOY_URL_PATTERN,
  QuickDeployLinksPageSchema,
  type QuickDeployLink,
} from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import { addConfiguration, addConfigurationVersion, addMembership, addQuickDeployLink, createUserWithOrganization, truncateAll, withFailingInsert } from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { sha256Hex, type OpampServerClient } from "../../opamp-server/client.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { hashPassword } from "../identity/password.js";
import { openValues } from "../quick-deploy/sealed-values.js";
import { quickDeploySecretHash } from "../quick-deploy/secret.js";
import type * as CatalogueRepository from "../collector-catalogue/repositories/collector-catalogue-repository.js";

/** A catalogue without one platform's binaries (Ruling 47's case the shared catalogue can't hold), cleared before each test. */
const overrides = vi.hoisted(() => ({ withoutPlatform: undefined as string | undefined }));

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

const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const DAY_MS = 86_400_000;

/** Three variables read, NGINX_ENV among them. */
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
  "",
].join("\n");

/** A Kubernetes group's version (D17d-2 Preflight ruling 4): YAML's variables, one the chart sets itself, and a YAML 1.1 word (offered like any other: D18 decision 23). */
const KUBERNETES_YAML = [YAML.trimEnd(), "      x-node: ${env:NODE_NAME}", "      x-word: ${env:ON}", ""].join("\n");

type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface Call {
  operation: keyof OpampServerClient;
  args: unknown[];
}

/**
 * D17c-2 decisions 4, 5, 10, 22 and 25; Preflight rulings 13, 15, 20 and 25:
 * the quick-deploy links' routes under a fleet, against Postgres through the
 * API as its own role, with the OpenAPI-checked fake as the opamp-server.
 */
describe("the quick-deploy links' routes", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  let logLines: string[] = [];
  let runner: CollectingRunner;
  let calls: Call[] = [];
  /** A test's answer in place of the fake's, for one operation (the opamp-server failing, or refusing). */
  let hooks: Partial<Record<keyof OpampServerClient, (...args: unknown[]) => Promise<unknown>>> = {};

  const serverClient = new Proxy({} as OpampServerClient, {
    get(_target, property) {
      const operation = property as keyof OpampServerClient;
      return (...args: unknown[]) => {
        calls.push({ operation, args });
        const hook = hooks[operation];
        if (hook !== undefined) return hook(...args);
        return (opamp.client[operation] as (...given: unknown[]) => Promise<unknown>)(...args);
      };
    },
  });

  function build(rateLimits: RateLimits = TEST_RATE_LIMITS): FastifyInstance {
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
    server = build();
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
    overrides.withoutPlatform = undefined;
  });

  const operations = () => calls.map((call) => call.operation);
  const logged = () => logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  /** The links active at the API's clock in a fleet, counted in the database. */
  const activeLinks = async (fleetId: string) =>
    Number(
      (
        await sql<{ n: string }>`select count(*) as n from quick_deploy_links
          where fleet_id = ${fleetId} and revoked_at is null and (expires_at is null or expires_at > ${clock})`.execute(ownerDb)
      ).rows[0]!.n,
    );

  /**
   * A delete from `quick_deploy_links` refused for `body`'s length (a
   * trigger, dropped after whatever happens): withFailingInsert's method for
   * a delete, under its reserved prefix, so a killed run's leftover goes
   * with the global setup's (`test_fail_%`).
   */
  async function withFailingLinkDelete(body: () => Promise<void>): Promise<void> {
    const name = "test_fail_quick_deploy_links_delete";
    await sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`).execute(ownerDb);
    try {
      await sql.raw(`create trigger ${name} before delete on quick_deploy_links for each row execute function ${name}()`).execute(ownerDb);
      await body();
    } finally {
      await sql.raw(`drop trigger if exists ${name} on quick_deploy_links`).execute(ownerDb);
      await sql.raw(`drop function if exists ${name}()`).execute(ownerDb);
    }
  }

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message?: string): void {
    expect({ status: response.statusCode, code: response.json<{ error: { code: string } }>().error.code }).toEqual({ status: statusCode, code });
    if (message !== undefined) expect(response.json<{ error: { message: string } }>().error.message).toBe(message);
  }

  const detailPaths = (response: LightMyRequestResponse): string[] =>
    (response.json<{ error: { details?: { instancePath: string }[] } }>().error.details ?? []).map((detail) => detail.instancePath);

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

  const send = (person: Pick<Person, "access"> | undefined, method: Method, url: string, payload?: unknown, headers = csrfHeaders, on = server) =>
    on.inject({
      method,
      url,
      headers,
      ...(person === undefined ? {} : { cookies: { telflo_access: person.access } }),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  const fleetPath = (organizationId: string, fleetId: string) => `/api/v1/organizations/${organizationId}/fleets/${fleetId}`;
  const createPath = (organizationId: string, fleetId: string, groupId: string) => `${fleetPath(organizationId, fleetId)}/groups/${groupId}/quick-deploy-links`;
  const listPath = (organizationId: string, fleetId: string, query = "") => `${fleetPath(organizationId, fleetId)}/quick-deploy-links${query}`;
  const linkPath = (organizationId: string, fleetId: string, linkId: string, action: "extend" | "revoke") =>
    `${fleetPath(organizationId, fleetId)}/quick-deploy-links/${linkId}/${action}`;

  let labels = 0;

  const created = async (person: Person, organizationId: string, type = "server") => {
    const label = `edge-prod-${++labels}-${randomUUID()}`;
    const response = await send(person, "POST", `/api/v1/organizations/${organizationId}/fleets`, { label, type, rotateExpiresAt: null });
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      fleet: { id: string };
      defaultGroup: { id: string; name: string };
      tokens: { default: { id: string; bearer: string }; rotate: { bearer: string } };
    }>();
    return {
      fleetId: body.fleet.id,
      defaultGroupId: body.defaultGroup.id,
      defaultGroupName: body.defaultGroup.name,
      defaultTokenId: body.tokens.default.id,
      label,
      bearers: [body.tokens.default.bearer, body.tokens.rotate.bearer],
    };
  };

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

  /** An admin and a contributor, a server fleet whose Default group is assigned a published version, and a second, unassigned group. */
  const aWorld = async () => {
    const { organizationId, person: admin } = await member("admin");
    const { person: contributor } = await member("contributor", organizationId);
    const fleet = await created(admin, organizationId);
    const published = await publishedVersion(organizationId, admin.userId);
    const assigned = await send(admin, "PATCH", `${fleetPath(organizationId, fleet.fleetId)}/groups/${fleet.defaultGroupId}`, {
      assignedVersionId: published.versionId,
    });
    expect(assigned.statusCode).toBe(200);
    const second = await send(admin, "POST", `${fleetPath(organizationId, fleet.fleetId)}/groups`, { name: `group-${++labels}` });
    expect(second.statusCode).toBe(201);
    calls = [];
    logLines = [];
    return { organizationId, admin, contributor, ...fleet, published, unassignedGroupId: second.json<{ group: { id: string } }>().group.id };
  };

  type World = Awaited<ReturnType<typeof aWorld>>;

  const VALUE = "prod-value-canary-7d1f";
  const linkRequest = (overrides: Record<string, unknown> = {}) => ({
    method: "all-in-one",
    arch: "amd64",
    rootPath: "/etc/otelcol/",
    env: [{ name: "NGINX_ENV", value: VALUE }],
    systemd: true,
    ...overrides,
  });

  /** A link made through the API: its reply's link and url. */
  const made = async (world: World, overrides: Record<string, unknown> = {}, person: Person = world.admin) => {
    const response = await send(person, "POST", createPath(world.organizationId, world.fleetId, world.defaultGroupId), linkRequest(overrides));
    expect(response.statusCode).toBe(201);
    return response.json<{ link: QuickDeployLink; url: string }>();
  };

  const linkAudits = (organizationId: string) =>
    ownerDb
      .selectFrom("audit_events")
      .select(["action", "subject_type", "subject_id", "metadata", "actor_user_id", "actor_email"])
      .where("organization_id", "=", organizationId)
      .where("action", "like", "quick_deploy_link.%")
      .orderBy("id")
      .execute();

  const auditText = async (organizationId: string) =>
    JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().where("organization_id", "=", organizationId).execute());

  const storedLink = (id: string) => ownerDb.selectFrom("quick_deploy_links").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  /**
   * D17d-2's world: a Kubernetes-supervisor fleet in a new organization (an
   * admin and a contributor) whose Agent (never saved) and gateway
   * traces-sampling (namespace tracing, 2 replicas) are assigned a published
   * version reading KUBERNETES_YAML.
   */
  const aKubernetesWorld = async () => {
    const { organizationId, person: admin } = await member("admin");
    const { person: contributor } = await member("contributor", organizationId);
    const fleet = await created(admin, organizationId, "kubernetes-supervisor");
    const published = await publishedVersion(organizationId, admin.userId, "0.162.0", KUBERNETES_YAML);
    const groups = `${fleetPath(organizationId, fleet.fleetId)}/groups`;
    const gateway = await send(admin, "POST", groups, {
      name: "traces-sampling",
      annotations: { telflo: { kubernetes: { role: "gateway", namespace: "tracing", replicas: 2, volumes: [] } } },
    });
    expect(gateway.statusCode).toBe(201);
    const gatewayId = gateway.json<{ group: { id: string } }>().group.id;
    for (const groupId of [fleet.defaultGroupId, gatewayId]) {
      expect((await send(admin, "PATCH", `${groups}/${groupId}`, { assignedVersionId: published.versionId })).statusCode).toBe(200);
    }
    calls = [];
    logLines = [];
    return { organizationId, admin, contributor, ...fleet, published, agentId: fleet.defaultGroupId, gatewayId };
  };

  const helmRequest = (env: { name: string; value: string }[] = [{ name: "NGINX_ENV", value: VALUE }]) => ({ kind: "helm", env });

  /** The organization's "Public install links" switch, by its admin (Task 2's route). */
  const setPublicInstallLinks = async (admin: Person, organizationId: string, publicInstallLinks: boolean) =>
    expect((await send(admin, "PATCH", `/api/v1/organizations/${organizationId}/settings`, { publicInstallLinks })).statusCode).toBe(200);

  // -------------------------------------------------------------------------

  describe("the create", () => {
    it.each(["admin", "contributor"] as const)("answers a %s 201 no-store with the link and its url, the one copy of the secret", async (role) => {
      const world = await aWorld();
      const response = await send(world[role], "POST", createPath(world.organizationId, world.fleetId, world.defaultGroupId), linkRequest());
      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const { link, url } = response.json<{ link: QuickDeployLink; url: string }>();
      expect(url).toMatch(QUICK_DEPLOY_URL_PATTERN);
      expect(url.startsWith(`${settings.quickDeploy.publicApiUrl}/api/v1/quick-deploy/tqd_`)).toBe(true);
      const secret = url.slice(url.lastIndexOf("/") + 1);
      expect(link).toEqual({
        id: expect.any(String),
        groupId: world.defaultGroupId,
        groupName: world.defaultGroupName,
        defaultTokenId: world.defaultTokenId,
        createdBy: { userId: world[role].userId, email: world[role].email },
        choices: { method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", executablePath: null, systemd: true, envNames: ["NGINX_ENV"] },
        createdAt: clock.toISOString(),
        expiresAt: new Date(clock.getTime() + DAY_MS).toISOString(),
        revokedAt: null,
        downloadCount: 0,
        lastDownloadedAt: null,
        status: "active",
      });
      // Stored as its hash only; the values sealed for the link.
      const row = await storedLink(link.id);
      expect(row.secret_hash).toBe(quickDeploySecretHash(secret));
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(Buffer.from(row.env_ciphertext!).toString("utf8")).not.toContain(VALUE);
      expect(
        openValues(settings.quickDeploy.keyRing, { ciphertext: Buffer.from(row.env_ciphertext!), keyId: row.env_key_id! }, { organizationId: world.organizationId, linkId: link.id }, ["NGINX_ENV"]),
      ).toEqual([{ name: "NGINX_ENV", value: VALUE }]);
      // No hash, no value, no bearer in the reply.
      for (const text of [row.secret_hash, VALUE, ...world.bearers]) expect(response.body).not.toContain(text);
      expect(operations()).toEqual(["getFleet", "getCollectorGroup", "listEnrollmentTokens"]);
      expect(await linkAudits(world.organizationId)).toEqual([
        {
          action: "quick_deploy_link.created",
          subject_type: "quick_deploy_link",
          subject_id: link.id,
          actor_user_id: world[role].userId,
          actor_email: world[role].email,
          metadata: { linkId: link.id, fleetId: world.fleetId, groupId: world.defaultGroupId, method: "all-in-one", arch: "amd64", systemd: true },
        },
      ]);
      const audited = await auditText(world.organizationId);
      for (const text of [secret, row.secret_hash, VALUE, "NGINX_ENV", "/etc/otelcol", world.label]) expect(audited).not.toContain(text);
    });

    it("own-binary with its executable path and no variable seals nothing", async () => {
      const world = await aWorld();
      const { link } = await made(world, { method: "own-binary", arch: "arm64", rootPath: "/srv/otel", executablePath: "/opt/bin/otelcol-contrib", env: [], systemd: false });
      expect(link.choices).toEqual({ method: "own-binary", arch: "arm64", rootPath: "/srv/otel", executablePath: "/opt/bin/otelcol-contrib", systemd: false, envNames: [] });
      const row = await storedLink(link.id);
      expect([row.env_ciphertext, row.env_key_id]).toEqual([null, null]);
    });

    it("refuses each invalid field with invalid_request, naming it, with no call and nothing stored", async () => {
      const world = await aWorld();
      const path = createPath(world.organizationId, world.fleetId, world.defaultGroupId);
      const cases: [Record<string, unknown>, string][] = [
        [linkRequest({ method: "container" }), "/method"],
        [linkRequest({ arch: "386" }), "/arch"],
        [linkRequest({ rootPath: "/etc/otel col" }), "/rootPath"],
        [linkRequest({ executablePath: "/usr/bin/otelcol-contrib" }), "/executablePath"],
        [linkRequest({ method: "own-binary" }), "/executablePath"],
        [linkRequest({ env: [{ name: "NGINX_ENV", value: "a\nb" }] }), "/env/0/value"],
        [linkRequest({ systemd: "yes" }), "/systemd"],
        [{ ...linkRequest(), systemd: undefined }, "/systemd"],
        [linkRequest({ displayName: "web-1" }), ""],
      ];
      for (const [body, field] of cases) {
        const response = await send(world.admin, "POST", path, body);
        expect({ field, status: response.statusCode, code: response.json<{ error: { code: string } }>().error.code }).toEqual({ field, status: 400, code: "invalid_request" });
        if (field !== "") expect(detailPaths(response)).toContain(field);
      }
      expect(operations()).toEqual([]);
      expect(await ownerDb.selectFrom("quick_deploy_links").selectAll().execute()).toEqual([]);
    });

    it("refuses a variable the group's version doesn't read, naming its index", async () => {
      const world = await aWorld();
      const response = await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.defaultGroupId), linkRequest({
        env: [{ name: "NGINX_ENV", value: "x" }, { name: "LD_PRELOAD", value: "x" }],
      }));
      expectRefusal(response, 400, "invalid_request");
      expect(detailPaths(response)).toEqual(["/env/1/name"]);
      expect(await linkAudits(world.organizationId)).toEqual([]);
    });

    it("refuses as the install does: unassigned, a Kubernetes-supervisor fleet, archived, an unknown group, a retired version", async () => {
      const world = await aWorld();
      expectRefusal(await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.unassignedGroupId), linkRequest()), 409, "collector_group_unassigned");
      expectRefusal(await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, randomUUID()), linkRequest()), 404, "collector_group_not_found");
      const kubernetes = await created(world.admin, world.organizationId, "kubernetes-supervisor");
      expectRefusal(await send(world.admin, "POST", createPath(world.organizationId, kubernetes.fleetId, kubernetes.defaultGroupId), linkRequest()), 409, "fleet_type_not_installable");
      const retired = await publishedVersion(world.organizationId, world.admin.userId, "0.158.0");
      await send(world.admin, "PATCH", `${fleetPath(world.organizationId, world.fleetId)}/groups/${world.unassignedGroupId}`, { assignedVersionId: retired.versionId });
      expectRefusal(await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.unassignedGroupId), linkRequest()), 409, "collector_version_not_offered");
      await send(world.admin, "PATCH", fleetPath(world.organizationId, world.fleetId), { status: "archived" });
      expectRefusal(await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.defaultGroupId), linkRequest()), 409, "fleet_archived");
      expect(await ownerDb.selectFrom("quick_deploy_links").selectAll().execute()).toEqual([]);
    });

    it("refuses an arch the catalogue has no binaries of, before anything is stored", async () => {
      const world = await aWorld();
      overrides.withoutPlatform = "linux_arm64";
      expectRefusal(
        await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.defaultGroupId), linkRequest({ arch: "arm64" })),
        409,
        "collector_version_not_offered",
        "Collector v0.162.0 has no arm64 binaries to install. Choose the other arch, or publish a version that has them.",
      );
      expect(operations()).toEqual(["getFleet", "getCollectorGroup"]);
      expect(await ownerDb.selectFrom("quick_deploy_links").selectAll().execute()).toEqual([]);
    });

    it("refuses 409 enrollment_token_default_missing with D17c-1's words once the default token is revoked; a new one makes links again", async () => {
      const world = await aWorld();
      expect((await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/tokens/${world.defaultTokenId}/revoke`)).statusCode).toBe(200);
      expectRefusal(
        await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.defaultGroupId), linkRequest()),
        409,
        "enrollment_token_default_missing",
        "The fleet's default token is revoked. Issue a new one on the Tokens tab, then install.",
      );
      expect(await ownerDb.selectFrom("quick_deploy_links").selectAll().execute()).toEqual([]);
      const issued = await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/tokens/default`);
      expect(issued.statusCode).toBe(201);
      const { link } = await made(world);
      expect(link.defaultTokenId).toBe(issued.json<{ token: { id: string } }>().token.id);
    });

    it("refuses 409 quick_deploy_link_limit_reached at 100 active links; an expired or revoked one doesn't count", async () => {
      const world = await aWorld();
      const at = clock.getTime();
      for (let index = 0; index < 99; index += 1) {
        await addQuickDeployLink(ownerDb, { organizationId: world.organizationId, fleet_id: world.fleetId, created_at: new Date(at - 1000), expires_at: new Date(at + DAY_MS) });
      }
      await addQuickDeployLink(ownerDb, { organizationId: world.organizationId, fleet_id: world.fleetId, created_at: new Date(at - 2 * DAY_MS), expires_at: new Date(at - DAY_MS) });
      await addQuickDeployLink(ownerDb, {
        organizationId: world.organizationId,
        fleet_id: world.fleetId,
        created_at: new Date(at - 1000),
        expires_at: new Date(at + DAY_MS),
        revoked_at: new Date(at - 500),
      });
      await made(world);
      expectRefusal(
        await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.defaultGroupId), linkRequest()),
        409,
        "quick_deploy_link_limit_reached",
        QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_limit_reached,
      );
      expect((await linkAudits(world.organizationId)).length).toBe(1);
    });

    it("needs the CSRF header and a session; another organization's path is 404 with no call", async () => {
      const world = await aWorld();
      const path = createPath(world.organizationId, world.fleetId, world.defaultGroupId);
      expect((await send(world.admin, "POST", path, linkRequest(), {} as typeof csrfHeaders)).statusCode).toBe(403);
      expectRefusal(await send(undefined, "POST", path, linkRequest()), 401, "unauthenticated");
      const { organizationId: otherOrganization, person: stranger } = await member("admin");
      expectRefusal(await send(stranger, "POST", path, linkRequest()), 404, "organization_not_found");
      expect(operations()).toEqual([]);
      expectRefusal(await send(stranger, "POST", createPath(otherOrganization, world.fleetId, world.defaultGroupId), linkRequest()), 404, "fleet_not_found");
      expect(await ownerDb.selectFrom("quick_deploy_links").selectAll().execute()).toEqual([]);
    });

    it("privacy: no value, path or secret in any log line of the create", async () => {
      const world = await aWorld();
      const { url } = await made(world, { rootPath: "/opt/root-path-canary", env: [{ name: "NGINX_ENV", value: VALUE }] });
      const secret = url.slice(url.lastIndexOf("/") + 1);
      expect(logLines.length).toBeGreaterThan(0);
      for (const text of [secret, VALUE, "/opt/root-path-canary", "NGINX_ENV"]) expect(logLines.filter((line) => line.includes(text))).toEqual([]);
    });

    it("spends a write (Preflight ruling 13's admissions)", async () => {
      const world = await aWorld();
      const oneWrite = build({ ...TEST_RATE_LIMITS, fleetWritesPerUser: { ...TEST_RATE_LIMITS.fleetWritesPerUser, max: 1 } });
      try {
        await oneWrite.ready();
        const path = createPath(world.organizationId, world.fleetId, world.defaultGroupId);
        expect((await send(world.admin, "POST", path, linkRequest(), csrfHeaders, oneWrite)).statusCode).toBe(201);
        expectRefusal(await send(world.admin, "POST", path, linkRequest(), csrfHeaders, oneWrite), 429, "rate_limited");
        expect((await send(world.admin, "GET", listPath(world.organizationId, world.fleetId), undefined, csrfHeaders, oneWrite)).statusCode).toBe(200);
      } finally {
        await oneWrite.close();
      }
    });
  });

  // -------------------------------------------------------------------------

  describe("a Helm values link (D17d-2 decisions 20 and 21; Preflight rulings 4, 11 and 13)", () => {
    it("makes a Helm values link: 201 no-store, choices by kind, values sealed, audited with ids and kind only", async () => {
      const world = await aKubernetesWorld();
      // A Helm body reaches the Helm path at the route (Ruling 36): its choices are the server's state, never the body's.
      const response = await send(world.contributor, "POST", createPath(world.organizationId, world.fleetId, world.gatewayId), helmRequest());
      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const { link, url } = response.json<{ link: QuickDeployLink; url: string }>();
      expect(url).toMatch(QUICK_DEPLOY_URL_PATTERN);
      const secret = url.slice(url.lastIndexOf("/") + 1);
      expect(link).toEqual({
        id: expect.any(String),
        groupId: world.gatewayId,
        groupName: "traces-sampling",
        defaultTokenId: world.defaultTokenId,
        createdBy: { userId: world.contributor.userId, email: world.contributor.email },
        choices: { kind: "helm", role: "gateway", release: "traces-sampling", namespace: "tracing", envNames: ["NGINX_ENV"] },
        createdAt: clock.toISOString(),
        expiresAt: new Date(clock.getTime() + DAY_MS).toISOString(),
        revokedAt: null,
        downloadCount: 0,
        lastDownloadedAt: null,
        status: "active",
      });
      expect(operations()).toEqual(["getFleet", "getCollectorGroup", "listEnrollmentTokens"]);
      const row = await storedLink(link.id);
      expect(row.choices).toEqual({ kind: "helm", role: "gateway", release: "traces-sampling", namespace: "tracing", envNames: ["NGINX_ENV"] });
      expect(row.secret_hash).toBe(quickDeploySecretHash(secret));
      expect(Buffer.from(row.env_ciphertext!).toString("utf8")).not.toContain(VALUE);
      expect(
        openValues(settings.quickDeploy.keyRing, { ciphertext: Buffer.from(row.env_ciphertext!), keyId: row.env_key_id! }, { organizationId: world.organizationId, linkId: link.id }, ["NGINX_ENV"]),
      ).toEqual([{ name: "NGINX_ENV", value: VALUE }]);
      for (const text of [row.secret_hash, VALUE, ...world.bearers]) expect(response.body).not.toContain(text);
      expect(await linkAudits(world.organizationId)).toEqual([
        {
          action: "quick_deploy_link.created",
          subject_type: "quick_deploy_link",
          subject_id: link.id,
          actor_user_id: world.contributor.userId,
          actor_email: world.contributor.email,
          metadata: { linkId: link.id, fleetId: world.fleetId, groupId: world.gatewayId, kind: "helm" },
        },
      ]);
      const audited = await auditText(world.organizationId);
      for (const text of [secret, row.secret_hash, VALUE, "NGINX_ENV", "traces-sampling", "tracing", world.label]) expect(audited).not.toContain(text);

      // The Agent before its first save: the defaults; no variable, nothing sealed. A body naming the group's
      // release or namespace is refused (strict): they are the server's.
      const agent = await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.agentId), helmRequest([]));
      expect(agent.statusCode).toBe(201);
      const agentLink = agent.json<{ link: QuickDeployLink }>().link;
      expect(agentLink.choices).toEqual({ kind: "helm", role: "node", release: "telflo-node", namespace: "telflo-collectors", envNames: [] });
      expect([(await storedLink(agentLink.id)).env_ciphertext, (await storedLink(agentLink.id)).env_key_id]).toEqual([null, null]);
      const named = await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.agentId), { ...helmRequest([]), namespace: "elsewhere" });
      expectRefusal(named, 400, "invalid_request");
      // An unknown kind is refused at kind; a Linux body's fields on a Helm one at the body.
      const unknownKind = await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.agentId), { kind: "docker", env: [] });
      expectRefusal(unknownKind, 400, "invalid_request");
      expect(detailPaths(unknownKind)).toContain("/kind");
      expectRefusal(await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.agentId), { ...linkRequest(), kind: "helm" }), 400, "invalid_request");
      expect((await linkAudits(world.organizationId)).length).toBe(2);
    });

    it("refuses a Helm link on a server fleet and a Linux link on a Kubernetes fleet, each direction's words", async () => {
      const world = await aWorld();
      const kubernetes = await aKubernetesWorld();
      calls = [];
      expectRefusal(
        await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.defaultGroupId), helmRequest()),
        409,
        "fleet_type_not_installable",
        FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE,
      );
      expect(operations()).toEqual(["getFleet"]);
      for (const body of [linkRequest(), { ...linkRequest(), kind: "linux" }]) {
        calls = [];
        expectRefusal(
          await send(kubernetes.admin, "POST", createPath(kubernetes.organizationId, kubernetes.fleetId, kubernetes.gatewayId), body),
          409,
          "fleet_type_not_installable",
          FLEET_TYPE_NOT_INSTALLABLE_MESSAGE,
        );
        expect(operations()).toEqual(["getFleet"]);
      }
      // A Kubernetes group whose settings can't be read makes no link.
      expect(
        (await opamp.client.updateCollectorGroup(kubernetes.organizationId, kubernetes.fleetId, kubernetes.gatewayId, { annotations: { telflo: "theirs" } })).kind,
      ).toBe("updated");
      expectRefusal(
        await send(kubernetes.admin, "POST", createPath(kubernetes.organizationId, kubernetes.fleetId, kubernetes.gatewayId), helmRequest()),
        409,
        "collector_group_settings_unreadable",
        COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
      );
      // Nor an unassigned group, nor once its default token is revoked (D17c-2's checks, the Helm link's too).
      const spare = await send(kubernetes.admin, "POST", `${fleetPath(kubernetes.organizationId, kubernetes.fleetId)}/groups`, {
        name: "spare",
        annotations: { telflo: { kubernetes: { role: "gateway", namespace: "tracing", volumes: [] } } },
      });
      expectRefusal(
        await send(kubernetes.admin, "POST", createPath(kubernetes.organizationId, kubernetes.fleetId, spare.json<{ group: { id: string } }>().group.id), helmRequest()),
        409,
        "collector_group_unassigned",
      );
      expect((await send(kubernetes.admin, "POST", `${fleetPath(kubernetes.organizationId, kubernetes.fleetId)}/tokens/${kubernetes.defaultTokenId}/revoke`)).statusCode).toBe(200);
      expectRefusal(
        await send(kubernetes.admin, "POST", createPath(kubernetes.organizationId, kubernetes.fleetId, kubernetes.agentId), helmRequest()),
        409,
        "enrollment_token_default_missing",
        QUICK_DEPLOY_LINK_ERROR_MESSAGES.enrollment_token_default_missing,
      );
      expect(await ownerDb.selectFrom("quick_deploy_links").selectAll().execute()).toEqual([]);
      expect(await linkAudits(world.organizationId)).toEqual([]);
      expect(await linkAudits(kubernetes.organizationId)).toEqual([]);
    });

    it("refuses a link of either kind while public install links are off, storing and auditing nothing", async () => {
      const world = await aWorld();
      const kubernetes = await aKubernetesWorld();
      await setPublicInstallLinks(world.admin, world.organizationId, false);
      await setPublicInstallLinks(kubernetes.admin, kubernetes.organizationId, false);
      const words = QUICK_DEPLOY_LINK_ERROR_MESSAGES.public_install_links_disabled;
      for (const person of [world.admin, world.contributor]) {
        expectRefusal(await send(person, "POST", createPath(world.organizationId, world.fleetId, world.defaultGroupId), linkRequest()), 409, "public_install_links_disabled", words);
      }
      for (const person of [kubernetes.admin, kubernetes.contributor]) {
        expectRefusal(await send(person, "POST", createPath(kubernetes.organizationId, kubernetes.fleetId, kubernetes.gatewayId), helmRequest()), 409, "public_install_links_disabled", words);
      }
      expect(await ownerDb.selectFrom("quick_deploy_links").selectAll().execute()).toEqual([]);
      expect(await linkAudits(world.organizationId)).toEqual([]);
      expect(await linkAudits(kubernetes.organizationId)).toEqual([]);
      for (const text of [VALUE, "NGINX_ENV"]) expect(logLines.filter((line) => line.includes(text))).toEqual([]);
      // Another organization's switch is its own.
      const other = await aWorld();
      expect((await send(other.admin, "POST", createPath(other.organizationId, other.fleetId, other.defaultGroupId), linkRequest())).statusCode).toBe(201);
      // On again, each kind is made.
      await setPublicInstallLinks(world.admin, world.organizationId, true);
      await setPublicInstallLinks(kubernetes.admin, kubernetes.organizationId, true);
      expect((await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.defaultGroupId), linkRequest())).statusCode).toBe(201);
      expect((await send(kubernetes.admin, "POST", createPath(kubernetes.organizationId, kubernetes.fleetId, kubernetes.gatewayId), helmRequest())).statusCode).toBe(201);
    });

    it("refuses a variable the chart sets itself or the version doesn't read", async () => {
      const world = await aKubernetesWorld();
      const path = createPath(world.organizationId, world.fleetId, world.gatewayId);
      // Each the chart sets itself (its env beats envFrom): 400 at its index, in its own words (Ruling 41), never the name.
      for (const name of HELM_CHART_ENV_NAMES) {
        const chartsOwn = await send(world.admin, "POST", path, helmRequest([{ name: "NGINX_ENV", value: "x" }, { name, value: "x" }]));
        expectRefusal(chartsOwn, 400, "invalid_request", HELM_CHART_ENV_NAME_MESSAGE);
        expect(
          chartsOwn.json<{ error: { details: { instancePath: string; message: string }[] } }>().error.details.map(({ instancePath, message }) => [instancePath, message]),
        ).toEqual([["/env/1/name", HELM_CHART_ENV_NAME_MESSAGE]]);
        expect(chartsOwn.body).not.toContain(name);
      }
      // One the version doesn't read: not offered, at its index.
      const notOffered = await send(world.admin, "POST", path, helmRequest([{ name: "LD_PRELOAD", value: "x" }]));
      expectRefusal(notOffered, 400, "invalid_request", "Only the variables this group's published version reads can be set.");
      expect(detailPaths(notOffered)).toEqual(["/env/0/name"]);
      // Each once, as a bundle's.
      const twice = await send(world.admin, "POST", path, helmRequest([{ name: "NGINX_ENV", value: "a" }, { name: "NGINX_ENV", value: "b" }]));
      expectRefusal(twice, 400, "invalid_request");
      expect(detailPaths(twice)).toEqual(["/env/1/name"]);
      expect(await ownerDb.selectFrom("quick_deploy_links").selectAll().execute()).toEqual([]);
      expect(await linkAudits(world.organizationId)).toEqual([]);
    });

    // D18 decision 23: the platform's chart quotes collectorEnv's keys, so a YAML 1.1 word the facts offer is a variable like any other.
    it("takes a YAML 1.1 word's variable the facts offer (ON): 201, stored in the link's choices and its sealed values", async () => {
      const world = await aKubernetesWorld();
      const response = await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.gatewayId), helmRequest([{ name: "NGINX_ENV", value: "x" }, { name: "ON", value: VALUE }]));
      expect(response.statusCode).toBe(201);
      const { link } = response.json<{ link: QuickDeployLink }>();
      expect(link.choices).toEqual({ kind: "helm", role: "gateway", release: "traces-sampling", namespace: "tracing", envNames: ["NGINX_ENV", "ON"] });
      const row = await storedLink(link.id);
      expect(row.choices).toEqual({ kind: "helm", role: "gateway", release: "traces-sampling", namespace: "tracing", envNames: ["NGINX_ENV", "ON"] });
      expect(
        openValues(settings.quickDeploy.keyRing, { ciphertext: Buffer.from(row.env_ciphertext!), keyId: row.env_key_id! }, { organizationId: world.organizationId, linkId: link.id }, ["NGINX_ENV", "ON"]),
      ).toEqual([
        { name: "NGINX_ENV", value: "x" },
        { name: "ON", value: VALUE },
      ]);
      expect(response.body).not.toContain(VALUE);
    });

    it("refuses a Helm link's value holding a lone surrogate 400 at env.0.value, storing nothing", async () => {
      const world = await aKubernetesWorld();
      const response = await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.gatewayId), helmRequest([{ name: "NGINX_ENV", value: "x\ud800" }]));
      expectRefusal(response, 400, "invalid_request");
      expect(detailPaths(response)).toEqual(["/env/0/value"]);
      expect(operations()).toEqual([]);
      expect(await ownerDb.selectFrom("quick_deploy_links").selectAll().execute()).toEqual([]);
    });

    it("lists, extends and revokes a Helm link", async () => {
      const world = await aKubernetesWorld();
      const { link } = (await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.gatewayId), helmRequest())).json<{ link: QuickDeployLink }>();
      const agent = (await send(world.admin, "POST", createPath(world.organizationId, world.fleetId, world.agentId), helmRequest([]))).json<{ link: QuickDeployLink }>().link;

      const listed = await send(world.admin, "GET", listPath(world.organizationId, world.fleetId));
      expect(listed.statusCode).toBe(200);
      const page = QuickDeployLinksPageSchema.parse(listed.json());
      expect(page.links.map(({ id, groupName, choices, status }) => ({ id, groupName, choices, status }))).toEqual([
        { id: agent.id, groupName: world.defaultGroupName, choices: { kind: "helm", role: "node", release: "telflo-node", namespace: "telflo-collectors", envNames: [] }, status: "active" },
        { id: link.id, groupName: "traces-sampling", choices: { kind: "helm", role: "gateway", release: "traces-sampling", namespace: "tracing", envNames: ["NGINX_ENV"] }, status: "active" },
      ]);
      expect(listed.body).not.toContain(VALUE);

      clock = new Date(clock.getTime() + 60_000);
      const extended = await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, link.id, "extend"), { by: "1w" });
      expect(extended.statusCode).toBe(200);
      expect(extended.json<{ link: QuickDeployLink }>().link).toMatchObject({
        id: link.id,
        choices: link.choices,
        expiresAt: new Date(clock.getTime() + 7 * DAY_MS).toISOString(),
        status: "active",
      });
      const revoked = await send(world.contributor, "POST", linkPath(world.organizationId, world.fleetId, link.id, "revoke"));
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json<{ link: QuickDeployLink }>().link).toMatchObject({ id: link.id, choices: link.choices, revokedAt: clock.toISOString(), status: "revoked" });
      expect((await linkAudits(world.organizationId)).map(({ action, metadata }) => [action, (metadata as { linkId: string }).linkId])).toEqual([
        ["quick_deploy_link.created", link.id],
        ["quick_deploy_link.created", agent.id],
        ["quick_deploy_link.extended", link.id],
        ["quick_deploy_link.revoked", link.id],
      ]);
      // A revoked Helm link stays listed, revoked; it can't be extended.
      expectRefusal(await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, link.id, "extend"), { by: "1d" }), 409, "quick_deploy_link_revoked");
      const after = QuickDeployLinksPageSchema.parse((await send(world.admin, "GET", listPath(world.organizationId, world.fleetId))).json());
      expect(after.links.find((each) => each.id === link.id)).toMatchObject({ status: "revoked", choices: link.choices });
    });
  });

  describe("the list", () => {
    it("lists the fleet's links newest first, keyset paged, each with its group's name from one call, its status, never a secret, hash or value", async () => {
      const world = await aWorld();
      const first = await made(world);
      clock = new Date(clock.getTime() + 1000);
      const second = await made(world, {}, world.contributor);
      clock = new Date(clock.getTime() + 1000);
      const third = await made(world);
      // Revoked, and another expired (made by the database, outside the API's clock).
      expect((await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, second.link.id, "revoke"))).statusCode).toBe(200);
      const expired = await addQuickDeployLink(ownerDb, {
        organizationId: world.organizationId,
        fleet_id: world.fleetId,
        group_id: world.unassignedGroupId,
        created_at: new Date(clock.getTime() - 3 * DAY_MS),
        expires_at: new Date(clock.getTime() - DAY_MS),
      });
      // Another fleet's and a deleted group's.
      const other = await created(world.admin, world.organizationId);
      await addQuickDeployLink(ownerDb, { organizationId: world.organizationId, fleet_id: other.fleetId });
      const orphan = await addQuickDeployLink(ownerDb, {
        organizationId: world.organizationId,
        fleet_id: world.fleetId,
        created_at: new Date(clock.getTime() - 4 * DAY_MS),
        expires_at: new Date(clock.getTime() + DAY_MS),
      });
      calls = [];

      const page1 = await send(world.contributor, "GET", listPath(world.organizationId, world.fleetId, "?limit=2"));
      expect(page1.statusCode).toBe(200);
      expect(page1.headers["cache-control"]).toBeUndefined();
      const one = QuickDeployLinksPageSchema.parse(page1.json());
      expect(one.links.map((link) => link.id)).toEqual([third.link.id, second.link.id]);
      expect(one.links.map((link) => link.status)).toEqual(["active", "revoked"]);
      expect(one.nextCursor).not.toBeNull();
      expect(operations()).toEqual(["listCollectorGroups"]);
      const page2 = QuickDeployLinksPageSchema.parse(
        (await send(world.admin, "GET", listPath(world.organizationId, world.fleetId, `?limit=2&cursor=${one.nextCursor}`))).json(),
      );
      expect(page2.links.map((link) => [link.id, link.status, link.groupName])).toEqual([
        [first.link.id, "active", world.defaultGroupName],
        [expired.id, "expired", expect.stringMatching(/^group-/)],
      ]);
      const page3 = QuickDeployLinksPageSchema.parse(
        (await send(world.admin, "GET", listPath(world.organizationId, world.fleetId, `?limit=2&cursor=${page2.nextCursor}`))).json(),
      );
      expect(page3).toEqual({ links: [expect.objectContaining({ id: orphan.id, groupName: null, createdBy: null })], nextCursor: null });
      expect(one.links[1]!.createdBy).toEqual({ userId: world.contributor.userId, email: world.contributor.email });

      const bodies = [page1.body, JSON.stringify(page2), JSON.stringify(page3)].join("\n");
      const hashes = (await ownerDb.selectFrom("quick_deploy_links").select("secret_hash").execute()).map((row) => row.secret_hash);
      for (const text of [...hashes, VALUE, ...[first, second, third].map(({ url }) => url.slice(url.lastIndexOf("/") + 1))]) {
        expect(bodies).not.toContain(text);
      }
    });

    it("defaults to 50 a page; an unknown fleet lists nothing, with no call; a cursor it didn't give is 400 naming cursor", async () => {
      const world = await aWorld();
      for (let index = 0; index < 51; index += 1) await addQuickDeployLink(ownerDb, { organizationId: world.organizationId, fleet_id: world.fleetId });
      const page = QuickDeployLinksPageSchema.parse((await send(world.admin, "GET", listPath(world.organizationId, world.fleetId))).json());
      expect([page.links.length, page.nextCursor === null]).toEqual([50, false]);
      calls = [];
      expect((await send(world.admin, "GET", listPath(world.organizationId, randomUUID()))).json()).toEqual({ links: [], nextCursor: null });
      expect(operations()).toEqual([]);
      for (const cursor of ["nope", Buffer.from(`2026-10-17T10:00:00.000Z|${randomUUID()}|x`).toString("base64url"), Buffer.from("2026-13-17T10:00:00.000Z|x").toString("base64url")]) {
        const response = await send(world.admin, "GET", listPath(world.organizationId, world.fleetId, `?cursor=${cursor}`));
        expectRefusal(response, 400, "invalid_request");
        expect(detailPaths(response)).toEqual(["/cursor"]);
      }
      expectRefusal(await send(world.admin, "GET", listPath(world.organizationId, world.fleetId, "?limit=101")), 400, "invalid_request");
      expectRefusal(await send(world.admin, "GET", listPath(world.organizationId, "not-a-uuid")), 404, "fleet_not_found");
    });
  });

  // -------------------------------------------------------------------------

  describe("extend and revoke", () => {
    it.each([
      ["1d", (now: Date) => new Date(now.getTime() + DAY_MS).toISOString()],
      ["1w", (now: Date) => new Date(now.getTime() + 7 * DAY_MS).toISOString()],
      ["180d", (now: Date) => new Date(now.getTime() + 180 * DAY_MS).toISOString()],
      ["never", () => null],
    ] as const)("extends by %s counted from now, an expired link's too, audited with the member", async (by, expected) => {
      const world = await aWorld();
      const { link } = await made(world);
      // Made three days ago: it expired two days ago (moved in the database, the session's clock kept).
      await sql`update quick_deploy_links set created_at = ${new Date(clock.getTime() - 3 * DAY_MS)}, expires_at = ${new Date(clock.getTime() - 2 * DAY_MS)} where id = ${link.id}`.execute(ownerDb);
      const response = await send(world.contributor, "POST", linkPath(world.organizationId, world.fleetId, link.id, "extend"), { by });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ link: QuickDeployLink }>().link).toMatchObject({ id: link.id, expiresAt: expected(clock), status: "active", groupName: world.defaultGroupName });
      expect((await storedLink(link.id)).expires_at?.toISOString() ?? null).toBe(expected(clock));
      expect((await linkAudits(world.organizationId)).at(-1)).toEqual({
        action: "quick_deploy_link.extended",
        subject_type: "quick_deploy_link",
        subject_id: link.id,
        actor_user_id: world.contributor.userId,
        actor_email: world.contributor.email,
        metadata: { linkId: link.id, fleetId: world.fleetId, by, expiresAt: expected(clock) },
      });
    });

    it("refuses an expired link's extend at 100 active links (409 quick_deploy_link_limit_reached, Ruling 36): it stays expired, unaudited; an active link's extend still works", async () => {
      const world = await aWorld();
      const at = clock.getTime();
      const active = [];
      for (let index = 0; index < 100; index += 1) {
        active.push(
          await addQuickDeployLink(ownerDb, { organizationId: world.organizationId, fleet_id: world.fleetId, group_id: world.defaultGroupId, created_at: new Date(at - 1000), expires_at: new Date(at + DAY_MS) }),
        );
      }
      const expired = await addQuickDeployLink(ownerDb, {
        organizationId: world.organizationId,
        fleet_id: world.fleetId,
        group_id: world.defaultGroupId,
        created_at: new Date(at - 2 * DAY_MS),
        expires_at: new Date(at - DAY_MS),
      });
      for (const by of ["1w", "never"]) {
        expectRefusal(
          await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, expired.id, "extend"), { by }),
          409,
          "quick_deploy_link_limit_reached",
          QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_limit_reached,
        );
      }
      expect((await storedLink(expired.id)).expires_at).toEqual(expired.expires_at);
      expect(await activeLinks(world.fleetId)).toBe(100);
      expect(await linkAudits(world.organizationId)).toEqual([]);
      // An active link is counted already: its extend is no new one.
      expect((await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, active[0]!.id, "extend"), { by: "1w" })).statusCode).toBe(200);
      // A place freed, the expired link is extended.
      expect((await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, active[1]!.id, "revoke"))).statusCode).toBe(200);
      expect((await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, expired.id, "extend"), { by: "1d" })).statusCode).toBe(200);
      expect(await activeLinks(world.fleetId)).toBe(100);
    });

    it("revokes first: with the opamp-server unable to name the group, the revoke stands, 200 with the name null, audited", async () => {
      const world = await aWorld();
      const { link } = await made(world);
      const other = await made(world);
      calls = [];
      hooks.getCollectorGroup = async () => ({ kind: "unavailable", reason: "server_error", status: 503 });
      const revoked = await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, link.id, "revoke"));
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json<{ link: QuickDeployLink }>().link).toMatchObject({ id: link.id, groupName: null, revokedAt: clock.toISOString(), status: "revoked" });
      expect(await storedLink(link.id)).toMatchObject({ revoked_at: clock, revoked_by_user_id: world.admin.userId });
      expect((await linkAudits(world.organizationId)).map((row) => [row.action, row.subject_id])).toEqual([
        ["quick_deploy_link.created", link.id],
        ["quick_deploy_link.created", other.link.id],
        ["quick_deploy_link.revoked", link.id],
      ]);
      // The write before the call.
      expect(operations()).toEqual(["getCollectorGroup"]);
      // An extend still reads the name first: the opamp-server failing, 503 and nothing changed.
      const before = await storedLink(other.link.id);
      expectRefusal(await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, other.link.id, "extend"), { by: "1w" }), 503, "fleets_unavailable");
      expect(await storedLink(other.link.id)).toEqual(before);
    });

    it("extends by a calendar month and year in UTC", async () => {
      clock = new Date("2027-01-31T12:00:00.000Z");
      const world = await aWorld();
      const { link } = await made(world);
      const month = await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, link.id, "extend"), { by: "1mo" });
      expect(month.json<{ link: QuickDeployLink }>().link.expiresAt).toBe("2027-02-28T12:00:00.000Z");
      const year = await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, link.id, "extend"), { by: "1y" });
      expect(year.json<{ link: QuickDeployLink }>().link.expiresAt).toBe("2028-01-31T12:00:00.000Z");
      expectRefusal(await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, link.id, "extend"), { by: "2d" }), 400, "invalid_request");
    });

    it("revokes once: a repeat answers the link as it is, and every revoke is audited; a revoked link can't be extended", async () => {
      const world = await aWorld();
      const { link } = await made(world);
      const revoked = await send(world.contributor, "POST", linkPath(world.organizationId, world.fleetId, link.id, "revoke"));
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json<{ link: QuickDeployLink }>().link).toMatchObject({ revokedAt: clock.toISOString(), status: "revoked" });
      const firstRevokedAt = clock.toISOString();
      clock = new Date(clock.getTime() + 60_000);
      const again = await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, link.id, "revoke"));
      expect(again.json<{ link: QuickDeployLink }>().link).toMatchObject({ revokedAt: firstRevokedAt, status: "revoked" });
      expect((await storedLink(link.id)).revoked_by_user_id).toBe(world.contributor.userId);
      expectRefusal(
        await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, link.id, "extend"), { by: "1w" }),
        409,
        "quick_deploy_link_revoked",
        "This install link is revoked: make a new one.",
      );
      expect((await linkAudits(world.organizationId)).map((row) => [row.action, row.actor_user_id, row.metadata])).toEqual([
        ["quick_deploy_link.created", world.admin.userId, expect.any(Object)],
        ["quick_deploy_link.revoked", world.contributor.userId, { linkId: link.id, fleetId: world.fleetId }],
        ["quick_deploy_link.revoked", world.admin.userId, { linkId: link.id, fleetId: world.fleetId }],
      ]);
    });

    it("isolation: another organization's link and another fleet's are 404 quick_deploy_link_not_found, unchanged, through every path", async () => {
      const world = await aWorld();
      const { link } = await made(world);
      const { organizationId: otherOrganization, person: stranger } = await member("admin");
      const theirs = await created(stranger, otherOrganization);
      const another = await created(world.admin, world.organizationId);
      const before = await storedLink(link.id);
      for (const action of ["extend", "revoke"] as const) {
        const body = action === "extend" ? { by: "never" } : undefined;
        // Their organization's path, naming this organization's fleet or their own fleet.
        expectRefusal(await send(stranger, "POST", linkPath(otherOrganization, world.fleetId, link.id, action), body), 404, "quick_deploy_link_not_found");
        expectRefusal(await send(stranger, "POST", linkPath(otherOrganization, theirs.fleetId, link.id, action), body), 404, "quick_deploy_link_not_found");
        // This organization's path, naming it: the session's organization isn't the path's.
        expectRefusal(await send(stranger, "POST", linkPath(world.organizationId, world.fleetId, link.id, action), body), 404, "organization_not_found");
        // Another fleet of the same organization.
        expectRefusal(await send(world.admin, "POST", linkPath(world.organizationId, another.fleetId, link.id, action), body), 404, "quick_deploy_link_not_found");
        // Unknown and malformed ids.
        expectRefusal(await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, randomUUID(), action), body), 404, "quick_deploy_link_not_found");
        expectRefusal(await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, "not-a-uuid", action), body), 404, "quick_deploy_link_not_found");
      }
      expect((await send(stranger, "GET", listPath(otherOrganization, world.fleetId))).json()).toEqual({ links: [], nextCursor: null });
      expect((await send(world.admin, "GET", listPath(world.organizationId, another.fleetId))).json()).toEqual({ links: [], nextCursor: null });
      expect(await storedLink(link.id)).toEqual(before);
      expect((await linkAudits(world.organizationId)).map((row) => row.action)).toEqual(["quick_deploy_link.created"]);
      expect(await linkAudits(otherOrganization)).toEqual([]);
    });

    it("spends a write each; the list a read", async () => {
      const world = await aWorld();
      const { link } = await made(world);
      const oneRead = build({ ...TEST_RATE_LIMITS, fleetReadsPerUser: { ...TEST_RATE_LIMITS.fleetReadsPerUser, max: 1 } });
      const oneWrite = build({ ...TEST_RATE_LIMITS, fleetWritesPerUser: { ...TEST_RATE_LIMITS.fleetWritesPerUser, max: 1 } });
      try {
        await oneRead.ready();
        await oneWrite.ready();
        expect((await send(world.admin, "GET", listPath(world.organizationId, world.fleetId), undefined, csrfHeaders, oneRead)).statusCode).toBe(200);
        expectRefusal(await send(world.admin, "GET", listPath(world.organizationId, world.fleetId), undefined, csrfHeaders, oneRead), 429, "rate_limited");
        expect((await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, link.id, "extend"), { by: "1d" }, csrfHeaders, oneWrite)).statusCode).toBe(200);
        expectRefusal(await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, link.id, "revoke"), undefined, csrfHeaders, oneWrite), 429, "rate_limited");
      } finally {
        await oneRead.close();
        await oneWrite.close();
      }
    });

    it("needs the CSRF header and a session", async () => {
      const world = await aWorld();
      const { link } = await made(world);
      expect((await send(world.admin, "POST", linkPath(world.organizationId, world.fleetId, link.id, "revoke"), undefined, {} as typeof csrfHeaders)).statusCode).toBe(403);
      expectRefusal(await send(undefined, "POST", linkPath(world.organizationId, world.fleetId, link.id, "extend"), { by: "1d" }), 401, "unauthenticated");
      expectRefusal(await send(undefined, "GET", listPath(world.organizationId, world.fleetId)), 401, "unauthenticated");
    });
  });

  // -------------------------------------------------------------------------

  describe("a fleet's delete", () => {
    it("removes its links after the opamp-server's success, with the fleet.deleted row; another fleet's stay", async () => {
      const world = await aWorld();
      await made(world);
      await made(world);
      const other = await created(world.admin, world.organizationId);
      const kept = await addQuickDeployLink(ownerDb, { organizationId: world.organizationId, fleet_id: other.fleetId });
      expect((await send(world.admin, "DELETE", fleetPath(world.organizationId, world.fleetId))).statusCode).toBe(204);
      expect((await ownerDb.selectFrom("quick_deploy_links").select("id").execute()).map((row) => row.id)).toEqual([kept.id]);
      const deleted = await ownerDb.selectFrom("audit_events").select(["action", "metadata"]).where("action", "=", "fleet.deleted").execute();
      expect(deleted).toEqual([{ action: "fleet.deleted", metadata: { fleetId: world.fleetId } }]);
    });

    it("keeps the fleet's links when the opamp-server can't be asked for its delete (503)", async () => {
      const world = await aWorld();
      const { link, url } = await made(world);
      calls = [];
      // The opamp-server can't be asked for this test's own fleet's delete.
      hooks.deleteFleet = async (organizationId, fleetId) =>
        organizationId === world.organizationId && fleetId === world.fleetId
          ? { kind: "unavailable", reason: "server_error", status: 503 }
          : opamp.client.deleteFleet(organizationId as string, fleetId as string);
      expectRefusal(await send(world.admin, "DELETE", fleetPath(world.organizationId, world.fleetId)), 503, "fleets_unavailable");
      expect(operations()).toEqual(["deleteFleet"]);
      expect((await ownerDb.selectFrom("quick_deploy_links").select("id").execute()).map((row) => row.id)).toEqual([link.id]);
      expect(await ownerDb.selectFrom("audit_events").select("action").where("action", "=", "fleet.deleted").execute()).toEqual([]);
      // The link still downloads (the fleet is there, its delete not made).
      expect((await server.inject({ method: "GET", url: new URL(url).pathname })).statusCode).toBe(200);
    });

    it.each([
      ["the fleet", { kind: "fleet_not_found" }],
      ["the organization", { kind: "organization_not_found" }],
    ] as const)(
      "removes the links of a delete that outlasted the platform's wait at its retry's 404 (%s unknown), with no audit row; another fleet's stay",
      async (_label, notFound) => {
        const world = await aWorld();
        const { link, url } = await made(world);
        await made(world);
        const other = await created(world.admin, world.organizationId);
        const kept = await addQuickDeployLink(ownerDb, { organizationId: world.organizationId, fleet_id: other.fleetId });
        // The first delete is carried out by the opamp-server, but the platform stops waiting (503);
        // its retry finds the fleet gone (404).
        let attempts = 0;
        hooks.deleteFleet = async (organizationId, fleetId) => {
          if (organizationId !== world.organizationId || fleetId !== world.fleetId) return opamp.client.deleteFleet(organizationId as string, fleetId as string);
          attempts += 1;
          if (attempts > 1) return notFound;
          await opamp.client.deleteFleet(organizationId as string, fleetId as string);
          return { kind: "unavailable", reason: "server_error", status: 503 };
        };
        const linkIds = async () => (await ownerDb.selectFrom("quick_deploy_links").select("id").orderBy("id").execute()).map((row) => row.id);
        expectRefusal(await send(world.admin, "DELETE", fleetPath(world.organizationId, world.fleetId)), 503, "fleets_unavailable");
        expect((await linkIds()).length).toBe(3);
        // Meanwhile the fleet is gone: its links answer 410.
        const between = await server.inject({ method: "GET", url: new URL(url).pathname });
        expect({ status: between.statusCode, body: between.body }).toEqual({ status: 410, body: "This install link's fleet no longer exists.\n" });
        logLines = [];
        calls = [];
        expectRefusal(await send(world.admin, "DELETE", fleetPath(world.organizationId, world.fleetId)), 404, "fleet_not_found");
        expect(operations()).toEqual(["deleteFleet"]);
        expect(await linkIds()).toEqual([kept.id]);
        expect(await ownerDb.selectFrom("audit_events").select("action").where("action", "=", "fleet.deleted").execute()).toEqual([]);
        expect(logged().filter((line) => Number(line.level) >= 50)).toEqual([]);
        // The link is gone: an unknown link's 404.
        const after = await server.inject({ method: "GET", url: new URL(url).pathname });
        expect({ status: after.statusCode, body: after.body }).toEqual({ status: 404, body: "Install link not found.\n" });
        expect(link.id).not.toBe(kept.id);
      },
    );

    it("answers a never-known fleet's delete 404 and removes nothing", async () => {
      const world = await aWorld();
      const { link } = await made(world);
      expectRefusal(await send(world.admin, "DELETE", fleetPath(world.organizationId, randomUUID())), 404, "fleet_not_found");
      expect((await ownerDb.selectFrom("quick_deploy_links").select("id").execute()).map((row) => row.id)).toEqual([link.id]);
      expect(logged().filter((line) => Number(line.level) >= 50)).toEqual([]);
    });

    it("answers the 404 when the gone fleet's links can't be removed: one error line of ids, the links then download 410", async () => {
      const world = await aWorld();
      const { link, url } = await made(world);
      const secret = url.slice(url.lastIndexOf("/") + 1);
      hooks.deleteFleet = async (organizationId, fleetId) => {
        await opamp.client.deleteFleet(organizationId as string, fleetId as string);
        return { kind: "fleet_not_found" };
      };
      logLines = [];
      await withFailingLinkDelete(async () => {
        expectRefusal(await send(world.admin, "DELETE", fleetPath(world.organizationId, world.fleetId)), 404, "fleet_not_found");
      });
      expect((await ownerDb.selectFrom("quick_deploy_links").select("id").execute()).map((row) => row.id)).toEqual([link.id]);
      const errors = logged().filter((line) => line.level === 50);
      expect(errors).toEqual([
        expect.objectContaining({
          msg: "a gone fleet's quick-deploy links weren't removed: they answer 410",
          operation: "removeQuickDeployLinks",
          organizationId: world.organizationId,
          fleetId: world.fleetId,
          error: expect.any(String),
        }),
      ]);
      const fields = Object.keys(errors[0]!).filter((key) => !["level", "time", "pid", "hostname", "reqId", "msg"].includes(key));
      expect(fields.sort()).toEqual(["error", "fleetId", "operation", "organizationId"]);
      const download = await server.inject({ method: "GET", url: new URL(url).pathname });
      expect({ status: download.statusCode, body: download.body }).toEqual({ status: 410, body: "This install link's fleet no longer exists.\n" });
      for (const text of [secret, VALUE, "NGINX_ENV", "/etc/otelcol", world.label]) expect(logLines.filter((line) => line.includes(text))).toEqual([]);
    });

    it("keeps the links when the delete's transaction fails: 204, one error line of ids, the links then download 410 and still list", async () => {
      const world = await aWorld();
      const { link, url } = await made(world);
      const secret = url.slice(url.lastIndexOf("/") + 1);
      await withFailingInsert(ownerDb, "audit_events", "if new.action = 'fleet.deleted' then raise exception 'refused'; end if; return new", async () => {
        expect((await send(world.admin, "DELETE", fleetPath(world.organizationId, world.fleetId))).statusCode).toBe(204);
      });
      expect((await ownerDb.selectFrom("quick_deploy_links").select("id").execute()).map((row) => row.id)).toEqual([link.id]);
      expect(await ownerDb.selectFrom("audit_events").select("action").where("action", "=", "fleet.deleted").execute()).toEqual([]);
      // One error line, of ids, the action and the error's name.
      const errors = logged().filter((line) => line.level === 50);
      expect(errors).toEqual([
        expect.objectContaining({
          msg: "the fleet change's audit row wasn't written: the change stands",
          action: "fleet.deleted",
          organizationId: world.organizationId,
          subjectId: world.fleetId,
          fleetId: world.fleetId,
          error: expect.any(String),
        }),
      ]);
      const fields = Object.keys(errors[0]!).filter((key) => !["level", "time", "pid", "hostname", "reqId", "msg"].includes(key));
      expect(fields.sort()).toEqual(["action", "error", "fleetId", "organizationId", "subjectId"]);
      // The fleet is gone in the opamp-server: the link downloads 410, and the list still shows it, its group unnamed.
      const download = await server.inject({ method: "GET", url: new URL(url).pathname });
      expect({ status: download.statusCode, body: download.body }).toEqual({ status: 410, body: "This install link's fleet no longer exists.\n" });
      const listed = QuickDeployLinksPageSchema.parse((await send(world.admin, "GET", listPath(world.organizationId, world.fleetId))).json());
      expect(listed.links.map((each) => [each.id, each.status, each.groupName])).toEqual([[link.id, "active", null]]);
      for (const text of [secret, VALUE, "NGINX_ENV", "/etc/otelcol", world.label]) expect(logLines.filter((line) => line.includes(text))).toEqual([]);
    });
  });
});
