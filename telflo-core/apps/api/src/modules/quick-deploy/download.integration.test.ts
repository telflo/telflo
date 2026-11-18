import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { parse } from "yaml";
import {
  BEARER_PATTERN,
  COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE,
  COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
  COLLECTOR_GROUP_UNASSIGNED_MESSAGE,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE,
  FLEET_TYPE_NOT_INSTALLABLE_MESSAGE,
  HelmInstallFactsSchema,
  helmValuesInputOf,
  helmValuesYaml,
  INSTALL_UNAVAILABLE_MESSAGE,
  PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE,
  QUICK_DEPLOY_LINK_ERROR_MESSAGES,
  type QuickDeployLink,
} from "@telflo/contracts";
import {
  createDb,
  createPool,
  type Database,
  type OrganizationRole,
  type QuickDeployHelmChoicesColumn,
  type QuickDeployLinuxChoicesColumn,
} from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addQuickDeployLink,
  createUserWithOrganization,
  truncateAll,
  withFailingInsert,
} from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { DOWNLOADS_BUSY_MESSAGE } from "../../http/public-download.js";
import { RATE_LIMITED_MESSAGE, TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { sha256Hex, type OpampServerClient } from "../../opamp-server/client.js";
import { createInstallTemplateLoader, type InstallTemplateLoader } from "../../install/templates.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { hashPassword } from "../identity/password.js";
import type * as Contracts from "@telflo/contracts";
import type * as CatalogueRepository from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import type * as AuditRepository from "../identity/repositories/audit-repository.js";
import {
  DOWNLOAD_FLEET_ARCHIVED_MESSAGE,
  DOWNLOAD_FLEET_GONE_MESSAGE,
  DOWNLOAD_LINK_ENDED_MESSAGE,
  DOWNLOAD_LINK_EXPIRED_MESSAGE,
  DOWNLOAD_TOKEN_REVOKED_MESSAGE,
  DOWNLOAD_UNAVAILABLE_MESSAGE,
} from "./errors.js";
import { sealValues } from "./sealed-values.js";
import { generateQuickDeploySecret, quickDeploySecretHash } from "./secret.js";

/**
 * A catalogue without one platform's binaries; an error the `downloaded`
 * audit row's insert throws (one that isn't Postgres's, with any `code`);
 * an error the Helm values' builder throws (one that isn't its own
 * HelmBuildError: an unexpected one, Ruling 48). All cleared before each test.
 */
const overrides = vi.hoisted(() => ({
  withoutPlatform: undefined as string | undefined,
  downloadedAuditFails: undefined as Error | undefined,
  helmValuesYamlFails: undefined as Error | undefined,
}));

vi.mock("@telflo/contracts", async (importOriginal) => {
  const original = await importOriginal<typeof Contracts>();
  return {
    ...original,
    helmValuesYaml: (input: Parameters<typeof original.helmValuesYaml>[0]) => {
      if (overrides.helmValuesYamlFails !== undefined) throw overrides.helmValuesYamlFails;
      return original.helmValuesYaml(input);
    },
  };
});

vi.mock("../identity/repositories/audit-repository.js", async (importOriginal) => {
  const original = await importOriginal<typeof AuditRepository>();
  return {
    ...original,
    createAuditRepository: (...args: Parameters<typeof original.createAuditRepository>) => {
      const repository = original.createAuditRepository(...args);
      return {
        ...repository,
        record: async (event: Parameters<typeof repository.record>[0]) => {
          const failure = overrides.downloadedAuditFails;
          if (failure !== undefined && event.action === "quick_deploy_link.downloaded") throw failure;
          return repository.record(event);
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

const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const DAY_MS = 86_400_000;
/** Nothing a placeholder could still be (D17c-1 Ruling 11). */
const LEFTOVER = /\$\{[A-Z_][A-Z0-9_]*\}/;
/** A bearer's shape (decision 34): no run of 100 or more base64 characters in a public download. */
const BEARER_SHAPED = /[A-Za-z0-9+/]{100,}/;
const USER_AGENT = "curl/8.5.0 (quick-deploy test)";

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

/** A Kubernetes group's version (D17d-2): YAML's variables, one the chart sets itself, and a YAML 1.1 word (offered like any other: D18 decision 23). */
const KUBERNETES_YAML = [YAML.trimEnd(), "      x-node: ${env:NODE_NAME}", "      x-word: ${env:ON}", ""].join("\n");

interface Call {
  operation: keyof OpampServerClient;
  args: unknown[];
}

/**
 * D17c-2 decisions 6, 7, 9 and 26; Preflight rulings 4, 9, 10 and 13: the
 * public download, GET /api/v1/quick-deploy/{secret}, with no session,
 * against Postgres through the API as its own role, the OpenAPI-checked
 * fake as the opamp-server and the repository's templates.
 */
describe("the public quick-deploy download", () => {
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
  /** Runs before a call of the operation reaches the fake (a test's hold, a failure, a change meanwhile). */
  let before: Partial<Record<keyof OpampServerClient, () => Promise<void>>> = {};

  const serverClient = new Proxy({} as OpampServerClient, {
    get(_target, property) {
      const operation = property as keyof OpampServerClient;
      return async (...args: unknown[]) => {
        calls.push({ operation, args });
        await before[operation]?.();
        return (opamp.client[operation] as (...given: unknown[]) => Promise<unknown>)(...args);
      };
    },
  });

  function build(options: { rateLimits?: RateLimits; installTemplates?: InstallTemplateLoader; settings?: AppSettings } = {}): FastifyInstance {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    try {
      return buildServer({
        opampServer: serverClient,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: options.settings ?? settings,
        db,
        mailer: createInMemoryMailer(),
        now: () => clock,
        rateLimits: options.rateLimits ?? TEST_RATE_LIMITS,
        runAfterResponse: (task) => runner.run(task),
        logStream: { write: (line) => void logLines.push(line) },
        ...(options.installTemplates === undefined ? {} : { installTemplates: options.installTemplates }),
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
  }

  /** A server of the test's own (other limits, other templates), closed after it. */
  async function own(options: Parameters<typeof build>[0]): Promise<FastifyInstance> {
    const built = build(options);
    await built.ready();
    owned.push(built);
    return built;
  }
  let owned: FastifyInstance[] = [];

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    server = build();
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
    scratch = await mkdtemp(join(tmpdir(), "quick-deploy-download-"));
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await Promise.all(owned.map((each) => each.close()));
    owned = [];
    await truncateAll(ownerDb);
    clock = new Date(Math.floor(Date.now() / 1000) * 1000);
    logLines = [];
    runner = createCollectingRunner();
    calls = [];
    before = {};
    overrides.withoutPlatform = undefined;
    overrides.downloadedAuditFails = undefined;
    overrides.helmValuesYamlFails = undefined;
  });

  const operations = () => calls.map((call) => call.operation);
  const logged = () => logLines.map((line) => JSON.parse(line) as Record<string, unknown>);

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

  const send = (person: Person, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    server.inject({
      method,
      url,
      headers: csrfHeaders,
      cookies: { telflo_access: person.access },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  /** The public route, with no cookie: as curl asks. */
  const download = (secret: string, options: { on?: FastifyInstance; remoteAddress?: string; method?: "GET" | "HEAD" } = {}) =>
    (options.on ?? server).inject({
      method: options.method ?? "GET",
      url: `/api/v1/quick-deploy/${secret}`,
      remoteAddress: options.remoteAddress ?? "203.0.113.7",
      headers: { "user-agent": USER_AGENT },
    });

  const fleetPath = (organizationId: string, fleetId: string) => `/api/v1/organizations/${organizationId}/fleets/${fleetId}`;

  let labels = 0;

  const created = async (person: Person, organizationId: string, type = "server") => {
    const label = `edge-prod-${++labels}-${randomUUID()}`;
    const response = await send(person, "POST", `/api/v1/organizations/${organizationId}/fleets`, { label, type, rotateExpiresAt: null });
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      fleet: { id: string };
      defaultGroup: { id: string };
      tokens: { default: { id: string; bearer: string }; rotate: { bearer: string } };
    }>();
    return { fleetId: body.fleet.id, defaultGroupId: body.defaultGroup.id, defaultTokenId: body.tokens.default.id, label, bearers: [body.tokens.default.bearer, body.tokens.rotate.bearer] };
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
    const result = await opamp.client.postPublication(organizationId, version.publication_id as string, {
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

  const assign = async (world: { admin: Person; organizationId: string; fleetId: string }, groupId: string, versionId: string) => {
    expect((await send(world.admin, "PATCH", `${fleetPath(world.organizationId, world.fleetId)}/groups/${groupId}`, { assignedVersionId: versionId })).statusCode).toBe(200);
  };

  const aWorld = async () => {
    const { organizationId, person: admin } = await member("admin");
    const fleet = await created(admin, organizationId);
    const published = await publishedVersion(organizationId, admin.userId);
    await assign({ admin, organizationId, fleetId: fleet.fleetId }, fleet.defaultGroupId, published.versionId);
    const second = await send(admin, "POST", `${fleetPath(organizationId, fleet.fleetId)}/groups`, { name: `group-${++labels}` });
    expect(second.statusCode).toBe(201);
    calls = [];
    logLines = [];
    return { organizationId, admin, ...fleet, published, unassignedGroupId: second.json<{ group: { id: string } }>().group.id };
  };

  type World = Awaited<ReturnType<typeof aWorld>>;

  const VALUE = "prod-value-canary-7d1f";
  const QUOTED = "it's $(echo EXPANDED) prod";

  /** A link made through the API (the member's create): its id, its secret and its reply. */
  const made = async (world: World, body: Record<string, unknown> = {}) => {
    const response = await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/groups/${world.defaultGroupId}/quick-deploy-links`, {
      method: "all-in-one",
      arch: "amd64",
      rootPath: "/etc/otelcol",
      env: [
        { name: "NGINX_ENV", value: VALUE },
        { name: "BACKEND_API_KEY", value: QUOTED },
      ],
      systemd: true,
      ...body,
    });
    expect(response.statusCode).toBe(201);
    const { link, url } = response.json<{ link: QuickDeployLink; url: string }>();
    calls = [];
    logLines = [];
    return { link, id: link.id, secret: url.slice(url.lastIndexOf("/") + 1) };
  };

  /** A link written straight to the table (a fleet or group the create would refuse): its id and secret. */
  const seeded = async (
    world: World,
    row: { fleet_id?: string; group_id?: string; default_token_id?: string; created_at?: Date; expires_at?: Date | null; revoked_at?: Date | null } = {},
    choices: Partial<QuickDeployLinuxChoicesColumn> = {},
  ) => {
    const { secret, secretHash } = generateQuickDeploySecret();
    const link = await addQuickDeployLink(ownerDb, {
      organizationId: world.organizationId,
      fleet_id: world.fleetId,
      group_id: world.defaultGroupId,
      default_token_id: world.defaultTokenId,
      secret_hash: secretHash,
      choices: JSON.stringify({ method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", executablePath: null, systemd: true, envNames: [], ...choices }),
      created_at: new Date(clock.getTime() - 1000),
      expires_at: new Date(clock.getTime() + DAY_MS),
      ...row,
    });
    return { id: link.id, secret };
  };

  const stored = (id: string) => ownerDb.selectFrom("quick_deploy_links").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  const downloads = () =>
    ownerDb.selectFrom("audit_events").selectAll().where("action", "=", "quick_deploy_link.downloaded").orderBy("id").execute();

  function expectPlainText(response: LightMyRequestResponse, statusCode: number, text: string): void {
    expect({ status: response.statusCode, body: response.body }).toEqual({ status: statusCode, body: `${text}\n` });
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  }

  /** Refused, and nothing counted or audited. */
  async function expectRefused(response: LightMyRequestResponse, statusCode: number, text: string, linkId?: string): Promise<void> {
    expectPlainText(response, statusCode, text);
    if (linkId !== undefined) expect((await stored(linkId)).download_count).toBe(0);
    expect(await downloads()).toEqual([]);
  }

  /**
   * An expected 5xx refusal's line (Ruling 36): at warn, the code and the
   * link's ids, no stack (no `err`); and no error-level line of the API's
   * handlers ("server error", "unhandled error") for it.
   */
  function expectRefusalLogged(code: string, world: Pick<World, "organizationId" | "fleetId">, linkId: string): void {
    expect(logged().filter((line) => line.msg === "public download refused")).toEqual([
      { level: 40, time: expect.any(Number), pid: expect.any(Number), hostname: expect.any(String), reqId: expect.any(String), msg: "public download refused", code, organizationId: world.organizationId, fleetId: world.fleetId, linkId },
    ]);
    expect(logged().filter((line) => line.err !== undefined || line.stack !== undefined)).toEqual([]);
    expect(logged().filter((line) => line.msg === "server error" || line.msg === "unhandled error")).toEqual([]);
  }

  async function extracted(archive: Buffer): Promise<Map<string, string>> {
    const directory = join(scratch, randomUUID());
    await mkdir(join(directory, "out"), { recursive: true });
    await writeFile(join(directory, "bundle.tar.gz"), archive);
    execFileSync("tar", ["-xzf", join(directory, "bundle.tar.gz"), "-C", join(directory, "out")]);
    const files = new Map<string, string>();
    for (const name of (await readdir(join(directory, "out"))).sort()) files.set(name, await readFile(join(directory, "out", name), "utf8"));
    return files;
  }

  // -------------------------------------------------------------------------

  describe("a download", () => {
    it("answers the link's bundle: 200 gzip, its headers and file name, the group's current version, the typed values, no bearer, label or placeholder", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      // The group's version changes after the link is made: the download renders the current one (decision 6).
      const newer = await publishedVersion(world.organizationId, world.admin.userId, "0.160.0");
      await assign(world, world.defaultGroupId, newer.versionId);
      calls = [];

      const response = await download(secret);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("application/gzip");
      expect(response.headers["content-disposition"]).toBe('attachment; filename="telflo-collector-all-in-one-amd64.tar.gz"');
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["set-cookie"]).toBeUndefined();
      const files = await extracted(response.rawPayload);
      expect([...files.keys()]).toEqual(["README.md", "otelcol-config.yaml", "start_supervisor.sh", "supervisor-config.yaml"]);
      for (const [name, text] of files) {
        expect({ name, leftover: LEFTOVER.exec(text)?.[0] ?? null, bearerShaped: BEARER_SHAPED.exec(text)?.[0] ?? null }).toEqual({ name, leftover: null, bearerShaped: null });
        for (const secretText of [...world.bearers, world.label, secret]) expect(text).not.toContain(secretText);
      }
      const script = files.get("start_supervisor.sh")!;
      expect(script).toContain("otelcol_version='0.160.0'\n");
      expect(script).toContain("root_path='/etc/otelcol'\n");
      expect(script).toContain(`export NGINX_ENV='${VALUE}'\n`);
      expect(script).toContain(`export BACKEND_API_KEY='it'\\''s $(echo EXPANDED) prod'\n`);
      expect(operations()).toEqual(["getFleet", "getCollectorGroup", "listEnrollmentTokens"]);

      // Counted once, at the API's clock; audited after the build with the requester, no actor, never the secret.
      expect(await stored(id)).toMatchObject({ download_count: 1, last_downloaded_at: clock });
      expect(await downloads()).toEqual([
        expect.objectContaining({
          action: "quick_deploy_link.downloaded",
          actor_user_id: null,
          actor_email: null,
          organization_id: world.organizationId,
          subject_type: "quick_deploy_link",
          subject_id: id,
          metadata: { linkId: id, fleetId: world.fleetId, groupId: world.defaultGroupId, method: "all-in-one", arch: "amd64" },
          ip_address: "203.0.113.7",
          user_agent: USER_AGENT,
        }),
      ]);
      const audited = JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().execute());
      for (const text of [secret, quickDeploySecretHash(secret), VALUE, "NGINX_ENV", "/etc/otelcol", world.label]) expect(audited).not.toContain(text);

      // A second download counts again; the member's list shows it.
      clock = new Date(clock.getTime() + 1000);
      expect((await download(secret, { remoteAddress: "198.51.100.4" })).statusCode).toBe(200);
      expect(await stored(id)).toMatchObject({ download_count: 2, last_downloaded_at: clock });
      expect((await downloads()).map((row) => row.ip_address)).toEqual(["203.0.113.7", "198.51.100.4"]);
    });

    it("own-binary, arm64: the link's paths, named by the method and arch", async () => {
      const world = await aWorld();
      const { secret } = await made(world, { method: "own-binary", arch: "arm64", rootPath: "/srv/otel", executablePath: "/opt/bin/otelcol-contrib", env: [] });
      const response = await download(secret);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toBe('attachment; filename="telflo-collector-own-binary-arm64.tar.gz"');
      const files = await extracted(response.rawPayload);
      const script = files.get("start_supervisor.sh")!;
      expect(script).toContain("executable_path='/opt/bin/otelcol-contrib'\n");
      expect(files.get("supervisor-config.yaml")).toContain("/srv/otel/otelcol-config.yaml");
      expect(script).not.toContain("export NGINX_ENV");
    });

    it("answers no HEAD (exposeHeadRoute: false): 404, nothing rendered, counted or audited", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      const response = await download(secret, { method: "HEAD" });
      expect(response.statusCode).toBe(404);
      expect(operations()).toEqual([]);
      expect((await stored(id)).download_count).toBe(0);
      expect(await downloads()).toEqual([]);
    });

    it("privacy: the secret reaches no log line of a whole request, a download's, a refusal's, an error's, a malformed URL's", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      const hash = quickDeploySecretHash(secret);
      expect((await download(secret)).statusCode).toBe(200);
      await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/quick-deploy-links/${id}/revoke`);
      expect((await download(secret)).statusCode).toBe(410);
      const other = await made(world);
      before.getFleet = async () => {
        throw new Error(`a failure quoting ${other.secret}`);
      };
      expect((await download(other.secret)).statusCode).toBe(503);
      before = {};
      // The router's own refusals (framework errors) answer as the route's: plain text, its headers, nothing echoed (Ruling 36).
      const malformed = await server.inject({ method: "GET", url: `/api/v1/quick-deploy/${secret}%zz`, headers: { "user-agent": USER_AGENT } });
      expectPlainText(malformed, 400, "The request was not valid.");
      const tooLong = await server.inject({ method: "GET", url: `/api/v1/quick-deploy/${secret}${"x".repeat(120)}` });
      expectPlainText(tooLong, 414, "The request's URL is too long.");
      expectPlainText(await download(`${secret.slice(0, -1)}%`), 400, "The request was not valid.");

      expect(logLines.length).toBeGreaterThan(5);
      expect(logged().some((line) => (line.req as { url?: string } | undefined)?.url === "/api/v1/quick-deploy/[redacted]")).toBe(true);
      for (const text of [secret, other.secret, hash, secret.slice(4), VALUE]) expect(logLines.filter((line) => line.includes(text))).toEqual([]);
      const audited = JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().execute());
      for (const text of [secret, other.secret, hash]) expect(audited).not.toContain(text);
    });
  });

  // -------------------------------------------------------------------------

  describe("its refusals, in Preflight ruling 10's order", () => {
    it("answers a secret of the wrong shape and an unknown one alike, 404 in plain text, with no call", async () => {
      const world = await aWorld();
      const { secret } = await made(world);
      for (const wrong of ["nope", secret.toUpperCase(), `${secret}x`, secret.slice(0, -1), `tqd_${"A".repeat(43)}`, generateQuickDeploySecret().secret]) {
        await expectRefused(await download(wrong), 404, "Install link not found.");
      }
      expect(operations()).toEqual([]);
    });

    it("counts every request per IP before the lookup, unknown secrets included: 429 with Retry-After in plain text", async () => {
      const world = await aWorld();
      const { secret } = await made(world);
      const limited = await own({ rateLimits: { ...TEST_RATE_LIMITS, quickDeployPerIp: { max: 2, windowMs: 60_000 } } });
      await expectRefused(await download("nope", { on: limited }), 404, "Install link not found.");
      await expectRefused(await download(generateQuickDeploySecret().secret, { on: limited }), 404, "Install link not found.");
      const refused = await download(secret, { on: limited });
      expectPlainText(refused, 429, RATE_LIMITED_MESSAGE);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      expect(operations()).toEqual([]);
      // Another address has its own count.
      expect((await download(secret, { on: limited, remoteAddress: "198.51.100.9" })).statusCode).toBe(200);
    });

    it("counts every attempt on a found link after the lookup, whatever refuses it next: 429 before revoked", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      const limited = await own({ rateLimits: { ...TEST_RATE_LIMITS, quickDeployPerLink: { max: 2, windowMs: 60_000 } } });
      expect((await download(secret, { on: limited })).statusCode).toBe(200);
      await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/quick-deploy-links/${id}/revoke`);
      expectPlainText(await download(secret, { on: limited }), 410, QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_revoked);
      const refused = await download(secret, { on: limited, remoteAddress: "198.51.100.9" });
      expectPlainText(refused, 429, RATE_LIMITED_MESSAGE);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      // Unknown secrets aren't any link's: still 404.
      expectPlainText(await download(generateQuickDeploySecret().secret, { on: limited }), 404, "Install link not found.");
      // Another link has its own count.
      expect((await download((await made(world)).secret, { on: limited })).statusCode).toBe(200);
    });

    it("refuses revoked, then expired, then the organization gone (410), with no call", async () => {
      const world = await aWorld();
      const both = await seeded(world, { created_at: new Date(clock.getTime() - 3 * DAY_MS), expires_at: new Date(clock.getTime() - DAY_MS), revoked_at: new Date(clock.getTime() - 2 * DAY_MS) });
      await expectRefused(await download(both.secret), 410, QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_revoked, both.id);
      const expired = await seeded(world, { created_at: new Date(clock.getTime() - 3 * DAY_MS), expires_at: clock });
      await expectRefused(await download(expired.secret), 410, DOWNLOAD_LINK_EXPIRED_MESSAGE, expired.id);
      const live = await seeded(world);
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", world.organizationId).execute();
      await expectRefused(await download(live.secret), 410, DOWNLOAD_FLEET_GONE_MESSAGE, live.id);
      // Expired wins over the organization gone.
      await expectRefused(await download(expired.secret), 410, DOWNLOAD_LINK_EXPIRED_MESSAGE, expired.id);
      expect(operations()).toEqual([]);
    });

    it("refuses the fleet gone, another organization's or archived (410); a Kubernetes-supervisor fleet (409)", async () => {
      const world = await aWorld();
      const { organizationId: otherOrganization, person: stranger } = await member("admin");
      const theirs = await created(stranger, otherOrganization);
      const another = await seeded(world, { fleet_id: theirs.fleetId, group_id: theirs.defaultGroupId, default_token_id: theirs.defaultTokenId });
      calls = [];
      await expectRefused(await download(another.secret), 410, DOWNLOAD_FLEET_GONE_MESSAGE, another.id);
      // Asked of the link's own organization only.
      expect(calls.every((call) => call.args[0] === world.organizationId)).toBe(true);

      const kubernetes = await created(world.admin, world.organizationId, "kubernetes-supervisor");
      const onKubernetes = await seeded(world, { fleet_id: kubernetes.fleetId, group_id: kubernetes.defaultGroupId, default_token_id: kubernetes.defaultTokenId });
      await expectRefused(await download(onKubernetes.secret), 409, FLEET_TYPE_NOT_INSTALLABLE_MESSAGE, onKubernetes.id);

      const { id, secret } = await made(world);
      expect((await send(world.admin, "PATCH", fleetPath(world.organizationId, world.fleetId), { status: "archived" })).statusCode).toBe(200);
      await expectRefused(await download(secret), 410, DOWNLOAD_FLEET_ARCHIVED_MESSAGE, id);
      // Deleted in the opamp-server with its links left behind (the platform's removal failed).
      expect((await opamp.client.deleteFleet(world.organizationId, world.fleetId)).kind).toBe("deleted");
      await expectRefused(await download(secret), 410, DOWNLOAD_FLEET_GONE_MESSAGE, id);
    });

    it("refuses the group gone or unassigned, a deleted configuration's version, a retired version, an arch not offered, variables no longer read (409)", async () => {
      const world = await aWorld();
      const gone = await seeded(world, { group_id: randomUUID() });
      await expectRefused(await download(gone.secret), 409, "Collector group not found", gone.id);
      const unassigned = await seeded(world, { group_id: world.unassignedGroupId });
      await expectRefused(await download(unassigned.secret), 409, COLLECTOR_GROUP_UNASSIGNED_MESSAGE, unassigned.id);
      const changed = await seeded(world, {}, { envNames: ["NGINX_ENV", "NO_LONGER_READ"] });
      await expectRefused(await download(changed.secret), 409, QUICK_DEPLOY_LINK_ERROR_MESSAGES.collector_group_variables_changed, changed.id);

      const { id, secret } = await made(world, { arch: "arm64" });
      overrides.withoutPlatform = "linux_arm64";
      await expectRefused(
        await download(secret),
        409,
        "Collector v0.162.0 has no arm64 binaries to install. Choose the other arch, or publish a version that has them.",
        id,
      );
      overrides.withoutPlatform = undefined;

      const retired = await publishedVersion(world.organizationId, world.admin.userId, "0.158.0");
      await assign(world, world.defaultGroupId, retired.versionId);
      await expectRefused(
        await download(secret),
        409,
        "Collector v0.158.0 is no longer offered. Publish a version that uses an offered collector, then assign it.",
        id,
      );
      await assign(world, world.defaultGroupId, world.published.versionId);
      await ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", world.published.configurationId).execute();
      await expectRefused(await download(secret), 409, COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE, id);
    });

    it("refuses once the default token the link's command carries is revoked (410), even after a new default token", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      expect((await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/tokens/${world.defaultTokenId}/revoke`)).statusCode).toBe(200);
      await expectRefused(await download(secret), 410, DOWNLOAD_TOKEN_REVOKED_MESSAGE, id);
      expect((await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/tokens/default`)).statusCode).toBe(201);
      await expectRefused(await download(secret), 410, DOWNLOAD_TOKEN_REVOKED_MESSAGE, id);
      // A link of an unknown token alike.
      const unknownToken = await seeded(world, { default_token_id: randomUUID() });
      await expectRefused(await download(unknownToken.secret), 410, DOWNLOAD_TOKEN_REVOKED_MESSAGE, unknownToken.id);
    });

    it("answers 503 when the templates can't be used, the opamp-server can't answer, or the values can't be opened: nothing counted or audited", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      const broken = join(scratch, `broken-${randomUUID()}`);
      await mkdir(join(broken, "linux", "all-in-one"), { recursive: true });
      await writeFile(join(broken, "linux", "all-in-one", "README.md"), "template-text-canary ${NOT_KNOWN}\n");
      const brokenServer = await own({ installTemplates: createInstallTemplateLoader(broken) });
      await expectRefused(await download(secret, { on: brokenServer }), 503, INSTALL_UNAVAILABLE_MESSAGE, id);
      expect(logged().filter((line) => line.msg === "installing failed: the install templates can't be used")).toEqual([
        expect.objectContaining({ operation: "quickDeployBundle", linkId: id, fleetId: world.fleetId, file: "linux/all-in-one/README.md" }),
      ]);
      expectRefusalLogged("install_unavailable", world, id);

      logLines = [];
      before.listEnrollmentTokens = async () => {
        throw new Error("the opamp-server is down");
      };
      await expectRefused(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
      before = {};
      expectRefusalLogged("quick_deploy_unavailable", world, id);

      // A sealed value tampered with: the reason logged, never a value.
      const row = await stored(id);
      const tampered = Buffer.from(row.env_ciphertext!);
      const last = tampered.length - 1;
      tampered.writeUInt8(tampered.readUInt8(last) ^ 0xff, last);
      await ownerDb.updateTable("quick_deploy_links").set({ env_ciphertext: tampered } as never).where("id", "=", id).execute();
      logLines = [];
      await expectRefused(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
      expect(logged().filter((line) => line.msg === "the quick-deploy link's values can't be opened")).toEqual([
        expect.objectContaining({ operation: "quickDeployBundle", linkId: id, reason: "not_authentic" }),
      ]);
      expectRefusalLogged("quick_deploy_unavailable", world, id);
      expect(logLines.filter((line) => line.includes(VALUE))).toEqual([]);
    });

    it("refuses a link holding another link's sealed values (another link's id, of its organization or another's: the AAD's link half, Ruling 45): 503 not_authentic, ids only; the others still download", async () => {
      const one = await aWorld();
      const two = await aWorld();
      const source = await made(one);
      const sameOrganization = await made(one);
      const otherOrganization = await made(two);
      const untouched = await made(two);
      // The source link's sealed values, byte for byte, moved onto the two others.
      const sealed = await stored(source.id);
      for (const target of [sameOrganization, otherOrganization]) {
        await ownerDb
          .updateTable("quick_deploy_links")
          .set({ env_ciphertext: sealed.env_ciphertext, env_key_id: sealed.env_key_id } as never)
          .where("id", "=", target.id)
          .execute();
        expect([(await stored(target.id)).env_ciphertext, (await stored(target.id)).env_key_id]).toEqual([sealed.env_ciphertext, sealed.env_key_id]);
      }
      for (const [target, world] of [
        [sameOrganization, one],
        [otherOrganization, two],
      ] as const) {
        logLines = [];
        await expectRefused(await download(target.secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, target.id);
        expect(logged().filter((line) => line.msg === "the quick-deploy link's values can't be opened")).toEqual([
          {
            level: 50,
            time: expect.any(Number),
            pid: expect.any(Number),
            hostname: expect.any(String),
            msg: "the quick-deploy link's values can't be opened",
            operation: "quickDeployBundle",
            organizationId: world.organizationId,
            fleetId: world.fleetId,
            groupId: world.defaultGroupId,
            linkId: target.id,
            reason: "not_authentic",
          },
        ]);
        expectRefusalLogged("quick_deploy_unavailable", world, target.id);
        for (const text of [VALUE, "NGINX_ENV", "BACKEND_API_KEY", "EXPANDED", target.secret, source.secret, quickDeploySecretHash(target.secret)]) {
          expect(logLines.filter((line) => line.includes(text))).toEqual([]);
        }
      }
      // The links whose values weren't moved still download, the source's own included.
      for (const kept of [source, untouched]) {
        const response = await download(kept.secret);
        expect(response.statusCode).toBe(200);
        expect((await extracted(response.rawPayload)).get("start_supervisor.sh")).toContain(VALUE);
      }
    });

    it("refuses a link's own sealed values once its row is moved into another organization, its id kept (only the AAD's organization half differs, Ruling 51): 503 not_authentic, ids only; moved back, it downloads", async () => {
      const one = await aWorld();
      const two = await aWorld();
      const link = await made(one);
      const sealed = await stored(link.id);
      // As the table's owner: the same row (its id, secret hash, choices and sealed values kept) moved into the
      // other organization, onto that organization's fleet, group and default token, so every check before the
      // values' opening passes there and only the organization the values were sealed for differs.
      const moveTo = async (world: World) => {
        await ownerDb
          .updateTable("quick_deploy_links")
          .set({ organization_id: world.organizationId, fleet_id: world.fleetId, group_id: world.defaultGroupId, default_token_id: world.defaultTokenId } as never)
          .where("id", "=", link.id)
          .execute();
        const row = await stored(link.id);
        expect([row.id, row.organization_id, row.secret_hash, row.env_ciphertext, row.env_key_id]).toEqual([
          link.id,
          world.organizationId,
          sealed.secret_hash,
          sealed.env_ciphertext,
          sealed.env_key_id,
        ]);
      };
      await moveTo(two);
      logLines = [];
      await expectRefused(await download(link.secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, link.id);
      expect(logged().filter((line) => line.msg === "the quick-deploy link's values can't be opened")).toEqual([
        {
          level: 50,
          time: expect.any(Number),
          pid: expect.any(Number),
          hostname: expect.any(String),
          msg: "the quick-deploy link's values can't be opened",
          operation: "quickDeployBundle",
          organizationId: two.organizationId,
          fleetId: two.fleetId,
          groupId: two.defaultGroupId,
          linkId: link.id,
          reason: "not_authentic",
        },
      ]);
      expectRefusalLogged("quick_deploy_unavailable", two, link.id);
      for (const text of [VALUE, "NGINX_ENV", "BACKEND_API_KEY", "EXPANDED", link.secret, quickDeploySecretHash(link.secret)]) {
        expect(logLines.filter((line) => line.includes(text))).toEqual([]);
      }
      // Back in the organization its values were sealed for, the same row downloads with them.
      await moveTo(one);
      const response = await download(link.secret);
      expect(response.statusCode).toBe(200);
      expect((await extracted(response.rawPayload)).get("start_supervisor.sh")).toContain(VALUE);
    });

    it("refuses a link that names variables but holds no sealed values (malformed, Ruling 36): 503, logged, never a bundle without them", async () => {
      const world = await aWorld();
      const { id, secret } = await seeded(world, {}, { envNames: ["NGINX_ENV"] });
      expect([(await stored(id)).env_ciphertext, (await stored(id)).env_key_id]).toEqual([null, null]);
      await expectRefused(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
      expect(logged().filter((line) => line.msg === "the quick-deploy link's values can't be opened")).toEqual([
        expect.objectContaining({ level: 50, operation: "quickDeployBundle", linkId: id, fleetId: world.fleetId, reason: "malformed" }),
      ]);
      expectRefusalLogged("quick_deploy_unavailable", world, id);
      // A link of no variable and no values is served.
      expect((await download((await seeded(world)).secret)).statusCode).toBe(200);
    });

    it("refuses a Linux link whose stored value the render refuses (a lone surrogate sealed before Ruling 36): 503 at warn, the rule's words and ids only, nothing counted or audited", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      const LONE = "lone-canary-\ud800-value";
      const sealed = sealValues(
        settings.quickDeploy.keyRing,
        [{ name: "NGINX_ENV", value: LONE }, { name: "BACKEND_API_KEY", value: QUOTED }],
        { organizationId: world.organizationId, linkId: id },
      );
      await ownerDb.updateTable("quick_deploy_links").set({ env_ciphertext: sealed.ciphertext, env_key_id: sealed.keyId } as never).where("id", "=", id).execute();
      logLines = [];
      await expectRefused(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
      expect(logged().filter((line) => line.msg === "the quick-deploy link's bundle couldn't be rendered")).toEqual([
        {
          level: 40,
          time: expect.any(Number),
          pid: expect.any(Number),
          hostname: expect.any(String),
          msg: "the quick-deploy link's bundle couldn't be rendered",
          operation: "quickDeployBundle",
          organizationId: world.organizationId,
          fleetId: world.fleetId,
          groupId: world.defaultGroupId,
          linkId: id,
          source: "choices",
          reason: "an environment variable fails its rule",
        },
      ]);
      expectRefusalLogged("quick_deploy_unavailable", world, id);
      expect(logged().filter((line) => (line.level as number) >= 50)).toEqual([]);
      for (const text of ["lone-canary", "EXPANDED", "NGINX_ENV", "BACKEND_API_KEY", secret, secret.slice(4), quickDeploySecretHash(secret)]) {
        expect(logLines.filter((line) => line.includes(text))).toEqual([]);
      }
    });

    it("refuses a Linux link whose bundle the render refuses for an operator's value (the agent endpoint, set around loadSettings): 503 at error, the rule's words and ids only, no stack, nothing counted or audited", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      const broken = await own({ settings: { ...settings, install: { ...settings.install, agentPublicUrl: "https://opamp.example/endpoint-canary b" } } });
      await expectRefused(await download(secret, { on: broken }), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
      expect(logged().filter((line) => line.msg === "the quick-deploy link's bundle couldn't be rendered")).toEqual([
        {
          level: 50,
          time: expect.any(Number),
          pid: expect.any(Number),
          hostname: expect.any(String),
          msg: "the quick-deploy link's bundle couldn't be rendered",
          operation: "quickDeployBundle",
          organizationId: world.organizationId,
          fleetId: world.fleetId,
          groupId: world.defaultGroupId,
          linkId: id,
          source: "operator",
          reason: "the agent endpoint fails its rule",
        },
      ]);
      expectRefusalLogged("quick_deploy_unavailable", world, id);
      for (const text of ["endpoint-canary", VALUE, QUOTED, secret, secret.slice(4), quickDeploySecretHash(secret)]) {
        expect(logLines.filter((line) => line.includes(text))).toEqual([]);
      }
    });

    it("refuses a link revoked while it rendered (the counter's last gate): 410, nothing counted or audited", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      before.listEnrollmentTokens = async () => {
        await ownerDb.updateTable("quick_deploy_links").set({ revoked_at: clock, revoked_by_user_id: world.admin.userId }).where("id", "=", id).execute();
      };
      await expectRefused(await download(secret), 410, DOWNLOAD_LINK_ENDED_MESSAGE, id);
    });

    it("fails closed when the downloaded row can't be written: 503, nothing served, nothing counted (the provisional choice)", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      await withFailingInsert(ownerDb, "audit_events", "raise exception 'audit insert refused'", async () => {
        await expectRefused(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
      });
      expect((await stored(id)).last_downloaded_at).toBeNull();
      // At error, ids, the error's name and its SQLSTATE (the trigger's `raise exception`: P0001); the refusal at warn.
      expect(logged().filter((line) => line.msg === "the quick-deploy download's count or audit row wasn't written: nothing was served")).toEqual([
        expect.objectContaining({ level: 50, linkId: id, organizationId: world.organizationId, fleetId: world.fleetId, code: "P0001" }),
      ]);
      expectRefusalLogged("quick_deploy_unavailable", world, id);
      expect((await download(secret)).statusCode).toBe(200);
    });

    it("logs the fail-closed line's code only when it is a SQLSTATE (five digits or capitals): never another error's code, which could be free text", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      const FAILED = "the quick-deploy download's count or audit row wasn't written: nothing was served";
      const failedLine = (code?: string) => ({
        level: 50,
        time: expect.any(Number),
        pid: expect.any(Number),
        hostname: expect.any(String),
        msg: FAILED,
        operation: "quickDeployDownload",
        organizationId: world.organizationId,
        fleetId: world.fleetId,
        linkId: id,
        error: "Error",
        ...(code === undefined ? {} : { code }),
      });
      const CANARY = "a-free-text-canary";
      for (const code of ["ECONNRESET", "p0001", "P00011", "P000", "P0001\n", " P0001", "P0-01", CANARY, 23505, null]) {
        logLines = [];
        overrides.downloadedAuditFails = Object.assign(new Error(`a failure quoting ${CANARY}`), { code });
        await expectRefused(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
        expect(logged().filter((line) => line.msg === FAILED)).toEqual([failedLine()]);
        expectRefusalLogged("quick_deploy_unavailable", world, id);
        expect(logLines.filter((line) => line.includes(CANARY))).toEqual([]);
      }
      // A SQLSTATE is logged (as the trigger's P0001 above): digits and capitals, five.
      for (const code of ["40001", "57P01"]) {
        logLines = [];
        overrides.downloadedAuditFails = Object.assign(new Error("a failure"), { code });
        await expectRefused(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
        expect(logged().filter((line) => line.msg === FAILED)).toEqual([failedLine(code)]);
      }
      overrides.downloadedAuditFails = undefined;
      expect((await download(secret)).statusCode).toBe(200);
    });

    it("logs each concurrent refusal with its own request's ids (the ids kept per request, Ruling 40): two organizations' links refused 503 at the same moment", async () => {
      const one = await aWorld();
      const two = await aWorld();
      const a = await made(one);
      const b = await made(two);
      // Both requests hold at the token list, past the point each set its ids, before either is refused.
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      before.listEnrollmentTokens = async () => {
        arrived += 1;
        if (arrived === 2) release();
        await gate;
        throw new Error("the opamp-server is down");
      };
      const [ra, rb] = await Promise.all([download(a.secret, { remoteAddress: "198.51.100.11" }), download(b.secret, { remoteAddress: "198.51.100.22" })]);
      expect(arrived).toBe(2);
      expectPlainText(ra, 503, DOWNLOAD_UNAVAILABLE_MESSAGE);
      expectPlainText(rb, 503, DOWNLOAD_UNAVAILABLE_MESSAGE);
      const lines = logged();
      const addressOf = new Map(lines.filter((line) => line.msg === "incoming request").map((line) => [line.reqId, (line.req as { remoteAddress: string }).remoteAddress]));
      const refused = lines.filter((line) => line.msg === "public download refused");
      expect(refused).toHaveLength(2);
      expect(new Set(refused.map((line) => line.reqId)).size).toBe(2);
      const idsOf = { "198.51.100.11": { organizationId: one.organizationId, fleetId: one.fleetId, linkId: a.id }, "198.51.100.22": { organizationId: two.organizationId, fleetId: two.fleetId, linkId: b.id } };
      expect(refused.map((line) => addressOf.get(line.reqId)).sort()).toEqual(["198.51.100.11", "198.51.100.22"]);
      for (const line of refused) {
        expect(line).toEqual({
          level: 40,
          time: expect.any(Number),
          pid: expect.any(Number),
          hostname: expect.any(String),
          reqId: line.reqId,
          msg: "public download refused",
          code: "quick_deploy_unavailable",
          ...idsOf[addressOf.get(line.reqId) as keyof typeof idsOf],
        });
      }
      for (const text of [a.secret, b.secret, quickDeploySecretHash(a.secret), quickDeploySecretHash(b.secret)]) expect(logLines.filter((line) => line.includes(text))).toEqual([]);
    });

    it("holds at most 8 renders in flight: the 9th is 503 with Retry-After: 1, and the 8 then finish", async () => {
      const world = await aWorld();
      const { id, secret } = await made(world);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let waiting = 0;
      before.getFleet = async () => {
        waiting += 1;
        await held;
      };
      const running = Array.from({ length: 8 }, (_unused, index) => download(secret, { remoteAddress: `198.51.100.${index + 1}` }));
      await vi.waitFor(() => expect(waiting).toBe(8), { timeout: 10_000 });
      logLines = [];
      const busy = await download(secret);
      expectPlainText(busy, 503, DOWNLOADS_BUSY_MESSAGE);
      expect(busy.headers["retry-after"]).toBe("1");
      expectRefusalLogged("downloads_busy", world, id);
      release();
      expect((await Promise.all(running)).map((response) => response.statusCode)).toEqual(Array(8).fill(200));
      expect((await stored(id)).download_count).toBe(8);
      expect((await downloads()).length).toBe(8);
    });
  });

  // -------------------------------------------------------------------------

  describe("a Helm values link's download and the switch (D17d-2 decisions 1, 20 and 21; Preflight rulings 9 and 10)", () => {
    const groupsPath = (world: { organizationId: string; fleetId: string }) => `${fleetPath(world.organizationId, world.fleetId)}/groups`;
    const kubernetesSettings = (role: string, extra: Record<string, unknown> = {}) => ({
      telflo: { kubernetes: { role, namespace: "tracing", volumes: [], ...extra } },
    });
    const VOLUMES = [{ hostPath: "/var/log/app", hostPathType: "Directory", mountPath: "/mnt/app-logs", readOnly: true }];

    /** A gateway pool of the world's fleet, assigned `versionId` unless null: its id. */
    const gateway = async (world: { admin: Person; organizationId: string; fleetId: string }, name: string, versionId: string | null) => {
      const response = await send(world.admin, "POST", groupsPath(world), { name, annotations: kubernetesSettings("gateway", { replicas: 2 }) });
      expect(response.statusCode).toBe(201);
      const groupId = response.json<{ group: { id: string } }>().group.id;
      if (versionId !== null) await assign(world, groupId, versionId);
      return groupId;
    };

    /** An admin's Kubernetes-supervisor fleet whose gateway traces-sampling (namespace tracing, 2 replicas) reads KUBERNETES_YAML. */
    const aKubernetesWorld = async () => {
      const { organizationId, person: admin } = await member("admin");
      const fleet = await created(admin, organizationId, "kubernetes-supervisor");
      const published = await publishedVersion(organizationId, admin.userId, "0.162.0", KUBERNETES_YAML);
      const gatewayId = await gateway({ admin, organizationId, fleetId: fleet.fleetId }, "traces-sampling", published.versionId);
      calls = [];
      logLines = [];
      return { organizationId, admin, ...fleet, published, gatewayId };
    };
    type KubernetesWorld = Awaited<ReturnType<typeof aKubernetesWorld>>;

    /** A Helm values link made through the API (the member's create): its id, its secret and its reply. */
    const madeHelm = async (world: KubernetesWorld, groupId = world.gatewayId, env = [{ name: "NGINX_ENV", value: VALUE }, { name: "BACKEND_API_KEY", value: QUOTED }]) => {
      const response = await send(world.admin, "POST", `${groupsPath(world)}/${groupId}/quick-deploy-links`, { kind: "helm", env });
      expect(response.statusCode).toBe(201);
      const { link, url } = response.json<{ link: QuickDeployLink; url: string }>();
      calls = [];
      logLines = [];
      return { link, id: link.id, secret: url.slice(url.lastIndexOf("/") + 1) };
    };

    /** A Helm values link written straight to the table (a group or state the create would refuse): its id and secret. */
    const seededHelm = async (
      world: { organizationId: string; fleetId: string; defaultTokenId: string },
      groupId: string,
      row: { default_token_id?: string; created_at?: Date; expires_at?: Date | null; revoked_at?: Date | null } = {},
      choices: Partial<QuickDeployHelmChoicesColumn> = {},
    ) => {
      const { secret, secretHash } = generateQuickDeploySecret();
      const link = await addQuickDeployLink(ownerDb, {
        organizationId: world.organizationId,
        fleet_id: world.fleetId,
        group_id: groupId,
        default_token_id: world.defaultTokenId,
        secret_hash: secretHash,
        choices: JSON.stringify({ kind: "helm", role: "gateway", release: "traces-sampling", namespace: "tracing", envNames: [], ...choices }),
        created_at: new Date(clock.getTime() - 1000),
        expires_at: new Date(clock.getTime() + DAY_MS),
        ...row,
      });
      return { id: link.id, secret };
    };

    /** The organization's switch, by its admin (Task 2's route). */
    const setPublicInstallLinks = async (world: { admin: Person; organizationId: string }, publicInstallLinks: boolean) =>
      expect((await send(world.admin, "PATCH", `/api/v1/organizations/${world.organizationId}/settings`, { publicInstallLinks })).statusCode).toBe(200);

    const facts = async (world: KubernetesWorld, groupId: string) => {
      const response = await send(world.admin, "GET", `${groupsPath(world)}/${groupId}/install`);
      expect(response.statusCode).toBe(200);
      return HelmInstallFactsSchema.parse(response.json());
    };

    const reveals = () => calls.filter((call) => call.operation === "revealEnrollmentToken");

    it("serves a Helm link's values.yaml (200 text/yaml, attachment values.yaml, no-store, nosniff, no-referrer, the group's current version and settings, a bearer of the opamp-server's shape revealed with no actor, audited downloaded with kind helm, counted)", async () => {
      const world = await aKubernetesWorld();
      const { id, secret } = await madeHelm(world);
      // The group's version and settings change after the link is made: the download renders the current ones.
      const newer = await publishedVersion(world.organizationId, world.admin.userId, "0.160.0", KUBERNETES_YAML);
      await assign(world, world.gatewayId, newer.versionId);
      expect(
        (await send(world.admin, "PATCH", `${groupsPath(world)}/${world.gatewayId}`, { annotations: kubernetesSettings("gateway", { namespace: "tracing-2", replicas: 5, volumes: VOLUMES }) }))
          .statusCode,
      ).toBe(200);
      calls = [];

      const response = await download(secret);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/yaml; charset=utf-8");
      expect(response.headers["content-disposition"]).toBe('attachment; filename="values.yaml"');
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["set-cookie"]).toBeUndefined();
      // The fleet's default token revealed afresh, last, with no actor: never the create's bearers.
      expect(operations()).toEqual(["getFleet", "getCollectorGroup", "revealEnrollmentToken"]);
      expect(reveals()[0]!.args).toEqual([world.organizationId, world.fleetId, world.defaultTokenId, null]);
      const values = parse(response.body) as { token: string; image: { tag: string }; replicas: number; collectorEnv: Record<string, string> };
      expect(BEARER_PATTERN.test(values.token)).toBe(true);
      for (const bearer of world.bearers) expect(values.token).not.toBe(bearer);
      // Exactly the contracts' file for the group's current facts, the revealed bearer and the link's values.
      const current = await facts(world, world.gatewayId);
      expect(current.helm).toMatchObject({ namespace: "tracing-2", replicas: 5, volumes: VOLUMES });
      expect(response.body).toBe(
        helmValuesYaml(helmValuesInputOf(current, values.token, [{ name: "NGINX_ENV", value: VALUE }, { name: "BACKEND_API_KEY", value: QUOTED }])),
      );
      expect(values).toMatchObject({ image: { tag: "0.160.0" }, replicas: 5, collectorEnv: { NGINX_ENV: VALUE, BACKEND_API_KEY: QUOTED } });
      expect(response.body).not.toContain(world.label);
      expect(response.body).not.toContain(secret);

      // The opamp-server's `viewed` event names no person.
      const events = await send(world.admin, "GET", `${fleetPath(world.organizationId, world.fleetId)}/tokens/events`);
      expect(events.json<{ events: { tokenId: string; event: string; actor: unknown }[] }>().events[0]).toMatchObject({
        tokenId: world.defaultTokenId,
        event: "viewed",
        actor: null,
      });

      // Counted once; audited after the build with the requester, no actor, the kind, never the secret or the bearer.
      expect(await stored(id)).toMatchObject({ download_count: 1, last_downloaded_at: clock });
      expect(await downloads()).toEqual([
        expect.objectContaining({
          action: "quick_deploy_link.downloaded",
          actor_user_id: null,
          actor_email: null,
          organization_id: world.organizationId,
          subject_type: "quick_deploy_link",
          subject_id: id,
          metadata: { linkId: id, fleetId: world.fleetId, groupId: world.gatewayId, kind: "helm" },
          ip_address: "203.0.113.7",
          user_agent: USER_AGENT,
        }),
      ]);
      const audited = JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().execute());
      for (const text of [secret, quickDeploySecretHash(secret), values.token, VALUE, "NGINX_ENV", "tracing-2", world.label]) expect(audited).not.toContain(text);

      // Each download reveals a new bearer and counts again.
      clock = new Date(clock.getTime() + 1000);
      const again = await download(secret, { remoteAddress: "198.51.100.4" });
      expect(again.statusCode).toBe(200);
      expect((parse(again.body) as { token: string }).token).not.toBe(values.token);
      expect(await stored(id)).toMatchObject({ download_count: 2, last_downloaded_at: clock });
    });

    // D18 decision 23: the platform's chart quotes collectorEnv's keys, so a YAML 1.1 word's variable reaches the file.
    it("serves a Helm link holding a YAML 1.1 word's variable (ON): its typed value under a quoted key Helm's YAML 1.1 reads as ON", async () => {
      const world = await aKubernetesWorld();
      const { secret } = await madeHelm(world, world.gatewayId, [{ name: "ON", value: VALUE }]);
      const response = await download(secret);
      expect(response.statusCode).toBe(200);
      expect(response.body.split("\n")).toContain(`  "ON": "${VALUE}"`);
      for (const values of [parse(response.body), parse(response.body, { version: "1.1" })]) {
        expect((values as { collectorEnv: Record<string, string> }).collectorEnv).toEqual({ ON: VALUE });
      }
      const token = (parse(response.body) as { token: string }).token;
      expect(response.body).toBe(helmValuesYaml(helmValuesInputOf(await facts(world, world.gatewayId), token, [{ name: "ON", value: VALUE }])));
      expect(response.body).not.toContain("fullnameOverride");
    });

    // D18 decision 21; Preflight ruling 12: the Agent's download names its objects by the fleet's id.
    it("serves the Agent's Helm link with the fleet's fullnameOverride right after group", async () => {
      const world = await aKubernetesWorld();
      await assign(world, world.defaultGroupId, world.published.versionId);
      const { secret } = await madeHelm(world, world.defaultGroupId, [{ name: "NGINX_ENV", value: VALUE }]);
      const response = await download(secret);
      expect(response.statusCode).toBe(200);
      const lines = response.body.split("\n");
      expect(lines.slice(1, 4)).toEqual(['role: "node"', 'group: "node"', `fullnameOverride: "${world.fleetId.slice(0, 8)}-default"`]);
      expect((parse(response.body) as { fullnameOverride: string }).fullnameOverride).toBe(`${world.fleetId.slice(0, 8)}-default`);
    });

    it("refuses in order (revoked, expired, organization gone, switch off 403, archived, group deleted, unassigned, deleted configuration's, retired version, unreadable settings, variables changed, default token revoked)", async () => {
      const world = await aKubernetesWorld();
      const unreadable = (groupId: string) =>
        opamp.client.updateCollectorGroup(world.organizationId, world.fleetId, groupId, { annotations: { telflo: "theirs" } });
      // Revoked wins over expired; expired over the switch.
      const both = await seededHelm(world, world.gatewayId, { created_at: new Date(clock.getTime() - 3 * DAY_MS), expires_at: new Date(clock.getTime() - DAY_MS), revoked_at: new Date(clock.getTime() - 2 * DAY_MS) });
      await expectRefused(await download(both.secret), 410, QUICK_DEPLOY_LINK_ERROR_MESSAGES.quick_deploy_link_revoked, both.id);
      const expired = await seededHelm(world, world.gatewayId, { created_at: new Date(clock.getTime() - 3 * DAY_MS), expires_at: clock });
      await expectRefused(await download(expired.secret), 410, DOWNLOAD_LINK_EXPIRED_MESSAGE, expired.id);
      await setPublicInstallLinks(world, false);
      await expectRefused(await download(expired.secret), 410, DOWNLOAD_LINK_EXPIRED_MESSAGE, expired.id);
      // The switch before the fleet's state (archived) and the render.
      const live = await seededHelm(world, world.gatewayId);
      await expectRefused(await download(live.secret), 403, PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE, live.id);
      expect(operations()).toEqual([]);
      await setPublicInstallLinks(world, true);

      // The organization gone before the switch (another organization's world: its delete is for good).
      const gone = await aKubernetesWorld();
      const goneLink = await seededHelm(gone, gone.gatewayId);
      await setPublicInstallLinks(gone, false);
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", gone.organizationId).execute();
      await expectRefused(await download(goneLink.secret), 410, DOWNLOAD_FLEET_GONE_MESSAGE, goneLink.id);

      // Archived (410) before the group's state (another world: its fleet stays archived).
      const archived = await aKubernetesWorld();
      const archivedLink = await seededHelm(archived, randomUUID());
      expect((await send(archived.admin, "PATCH", fleetPath(archived.organizationId, archived.fleetId), { status: "archived" })).statusCode).toBe(200);
      await setPublicInstallLinks(archived, false);
      await expectRefused(await download(archivedLink.secret), 403, PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE, archivedLink.id);
      await setPublicInstallLinks(archived, true);
      await expectRefused(await download(archivedLink.secret), 410, DOWNLOAD_FLEET_ARCHIVED_MESSAGE, archivedLink.id);

      // A Helm link on a server fleet's group: the Helm direction's words.
      const server = await aWorld();
      const onServer = await seededHelm(server, server.defaultGroupId);
      await expectRefused(await download(onServer.secret), 409, FLEET_TYPE_NOT_HELM_INSTALLABLE_MESSAGE, onServer.id);

      calls = [];
      // The group deleted; unassigned (before its settings: they're unreadable too).
      const deleted = await seededHelm(world, randomUUID());
      await expectRefused(await download(deleted.secret), 409, "Collector group not found", deleted.id);
      const unassignedId = await gateway(world, "unassigned-pool", null);
      expect((await unreadable(unassignedId)).kind).toBe("updated");
      const unassigned = await seededHelm(world, unassignedId);
      await expectRefused(await download(unassigned.secret), 409, COLLECTOR_GROUP_UNASSIGNED_MESSAGE, unassigned.id);
      // A deleted configuration's version, before its settings.
      const doomed = await publishedVersion(world.organizationId, world.admin.userId, "0.162.0", KUBERNETES_YAML);
      const doomedId = await gateway(world, "doomed-pool", doomed.versionId);
      expect((await unreadable(doomedId)).kind).toBe("updated");
      await ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", doomed.configurationId).execute();
      const deletedVersion = await seededHelm(world, doomedId);
      await expectRefused(await download(deletedVersion.secret), 409, COLLECTOR_GROUP_ASSIGNMENT_DELETED_MESSAGE, deletedVersion.id);
      // A retired version, before its settings.
      const retired = await publishedVersion(world.organizationId, world.admin.userId, "0.158.0", KUBERNETES_YAML);
      const retiredId = await gateway(world, "retired-pool", retired.versionId);
      expect((await unreadable(retiredId)).kind).toBe("updated");
      const retiredLink = await seededHelm(world, retiredId);
      await expectRefused(
        await download(retiredLink.secret),
        409,
        "Collector v0.158.0 is no longer offered. Publish a version that uses an offered collector, then assign it.",
        retiredLink.id,
      );
      // Unreadable settings, before the variables.
      const unreadableId = await gateway(world, "unreadable-pool", world.published.versionId);
      expect((await unreadable(unreadableId)).kind).toBe("updated");
      const unreadableLink = await seededHelm(world, unreadableId, {}, { envNames: ["NO_LONGER_READ"] });
      await expectRefused(await download(unreadableLink.secret), 409, COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE, unreadableLink.id);
      // Variables no longer read and the chart's own, before the default token (a YAML word is offered: D18 decision 23).
      for (const envNames of [["NGINX_ENV", "NO_LONGER_READ"], ["NODE_NAME"]]) {
        const changed = await seededHelm(world, world.gatewayId, { default_token_id: randomUUID() }, { envNames });
        await expectRefused(await download(changed.secret), 409, QUICK_DEPLOY_LINK_ERROR_MESSAGES.collector_group_variables_changed, changed.id);
      }
      // Nothing revealed for any of them.
      expect(reveals()).toEqual([]);

      // The default token: unknown, then revoked (even after a new one): 410, revealed nothing.
      const unknownToken = await seededHelm(world, world.gatewayId, { default_token_id: randomUUID() });
      await expectRefused(await download(unknownToken.secret), 410, DOWNLOAD_TOKEN_REVOKED_MESSAGE, unknownToken.id);
      const { id, secret } = await madeHelm(world);
      expect((await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/tokens/${world.defaultTokenId}/revoke`)).statusCode).toBe(200);
      await expectRefused(await download(secret), 410, DOWNLOAD_TOKEN_REVOKED_MESSAGE, id);
      expect((await send(world.admin, "POST", `${fleetPath(world.organizationId, world.fleetId)}/tokens/default`)).statusCode).toBe(201);
      await expectRefused(await download(secret), 410, DOWNLOAD_TOKEN_REVOKED_MESSAGE, id);
      const events = await send(world.admin, "GET", `${fleetPath(world.organizationId, world.fleetId)}/tokens/events`);
      expect(events.json<{ events: { event: string }[] }>().events.filter((event) => event.event === "viewed")).toEqual([]);
    });

    it("while the switch is off every link's download is 403, counted by the limits, not downloaded, not audited, and works again once on", async () => {
      const linux = await aWorld();
      const kubernetes = await aKubernetesWorld();
      const linuxLink = await made(linux);
      const helmLink = await madeHelm(kubernetes);
      await setPublicInstallLinks(linux, false);
      await setPublicInstallLinks(kubernetes, false);
      calls = [];
      const auditsBefore = await ownerDb.selectFrom("audit_events").select("action").execute();

      await expectRefused(await download(linuxLink.secret), 403, PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE, linuxLink.id);
      await expectRefused(await download(helmLink.secret), 403, PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE, helmLink.id);
      // Nothing rendered: no call, no bearer revealed.
      expect(operations()).toEqual([]);

      // Counted by the per-link limit (every attempt on a found link) ...
      const perLink = await own({ rateLimits: { ...TEST_RATE_LIMITS, quickDeployPerLink: { max: 2, windowMs: 60_000 } } });
      for (const remoteAddress of ["198.51.100.1", "198.51.100.2"]) {
        expectPlainText(await download(helmLink.secret, { on: perLink, remoteAddress }), 403, PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE);
      }
      expectPlainText(await download(helmLink.secret, { on: perLink, remoteAddress: "198.51.100.3" }), 429, RATE_LIMITED_MESSAGE);
      // ... and by the per-IP limit.
      const perIp = await own({ rateLimits: { ...TEST_RATE_LIMITS, quickDeployPerIp: { max: 2, windowMs: 60_000 } } });
      expectPlainText(await download(linuxLink.secret, { on: perIp }), 403, PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE);
      expectPlainText(await download(helmLink.secret, { on: perIp }), 403, PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE);
      expectPlainText(await download(linuxLink.secret, { on: perIp }), 429, RATE_LIMITED_MESSAGE);

      // Not downloaded, not audited at all.
      expect((await stored(linuxLink.id)).download_count).toBe(0);
      expect((await stored(helmLink.id)).download_count).toBe(0);
      expect(await ownerDb.selectFrom("audit_events").select("action").execute()).toEqual(auditsBefore);
      expect(operations()).toEqual([]);

      // On again: each downloads.
      await setPublicInstallLinks(linux, true);
      await setPublicInstallLinks(kubernetes, true);
      expect((await download(linuxLink.secret)).statusCode).toBe(200);
      const helm = await download(helmLink.secret);
      expect(helm.statusCode).toBe(200);
      expect(helm.headers["content-type"]).toBe("text/yaml; charset=utf-8");
      expect((await downloads()).map((row) => row.subject_id)).toEqual([linuxLink.id, helmLink.id]);
    });

    it("re-checks the switch at the counter's gate", async () => {
      const kubernetes = await aKubernetesWorld();
      const linux = await aWorld();
      const helmLink = await madeHelm(kubernetes);
      const linuxLink = await made(linux);
      const switchTo = (organizationId: string, publicInstallLinks: boolean) =>
        ownerDb.updateTable("organizations").set({ public_install_links_enabled: publicInstallLinks }).where("id", "=", organizationId).execute();

      // Turned off while the Helm link rendered (as its bearer was revealed): 403, nothing counted or audited.
      before.revealEnrollmentToken = async () => {
        await switchTo(kubernetes.organizationId, false);
      };
      await expectRefused(await download(helmLink.secret), 403, PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE, helmLink.id);
      expect(reveals()).toHaveLength(1);
      // And while a Linux link rendered.
      before = {
        listEnrollmentTokens: async () => {
          await switchTo(linux.organizationId, false);
        },
      };
      await expectRefused(await download(linuxLink.secret), 403, PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE, linuxLink.id);
      before = {};
      await switchTo(kubernetes.organizationId, true);
      await switchTo(linux.organizationId, true);
      expect((await download(helmLink.secret)).statusCode).toBe(200);
      expect((await download(linuxLink.secret)).statusCode).toBe(200);
      expect((await stored(helmLink.id)).download_count).toBe(1);
    });

    it("fails closed", async () => {
      const world = await aKubernetesWorld();
      const { id, secret } = await madeHelm(world);
      await withFailingInsert(ownerDb, "audit_events", "raise exception 'audit insert refused'", async () => {
        await expectRefused(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
      });
      expect((await stored(id)).last_downloaded_at).toBeNull();
      expect(logged().filter((line) => line.msg === "the quick-deploy download's count or audit row wasn't written: nothing was served")).toEqual([
        expect.objectContaining({ level: 50, linkId: id, organizationId: world.organizationId, fleetId: world.fleetId, code: "P0001" }),
      ]);
      expectRefusalLogged("quick_deploy_unavailable", world, id);
      expect(logLines.filter((line) => BEARER_SHAPED.test(line))).toEqual([]);
      // The opamp-server unable to reveal: 503, nothing counted.
      before.revealEnrollmentToken = async () => {
        throw new Error("the opamp-server is down");
      };
      await expectRefused(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
      before = {};
      expect((await download(secret)).statusCode).toBe(200);
      expect((await stored(id)).download_count).toBe(1);
    });

    it("refuses a Helm link whose stored value the builder refuses (a lone surrogate sealed before Ruling 36): 503 at warn, the field and ids only, nothing counted or audited (Ruling 48)", async () => {
      const world = await aKubernetesWorld();
      const { id, secret } = await madeHelm(world);
      const sealed = sealValues(
        settings.quickDeploy.keyRing,
        [{ name: "NGINX_ENV", value: "lone-canary-\ud800-value" }, { name: "BACKEND_API_KEY", value: QUOTED }],
        { organizationId: world.organizationId, linkId: id },
      );
      await ownerDb.updateTable("quick_deploy_links").set({ env_ciphertext: sealed.ciphertext, env_key_id: sealed.keyId } as never).where("id", "=", id).execute();
      logLines = [];
      await expectRefused(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
      expect(logged().filter((line) => line.msg === "the Helm values link's values.yaml couldn't be built")).toEqual([
        {
          level: 40,
          time: expect.any(Number),
          pid: expect.any(Number),
          hostname: expect.any(String),
          msg: "the Helm values link's values.yaml couldn't be built",
          operation: "quickDeployHelmValues",
          organizationId: world.organizationId,
          fleetId: world.fleetId,
          groupId: world.gatewayId,
          linkId: id,
          source: "choices",
          field: "collectorEnv.0.value",
        },
      ]);
      expectRefusalLogged("quick_deploy_unavailable", world, id);
      expect(logged().filter((line) => (line.level as number) >= 50)).toEqual([]);
      for (const text of ["lone-canary", "EXPANDED", "NGINX_ENV", "BACKEND_API_KEY", secret, secret.slice(4), quickDeploySecretHash(secret)]) {
        expect(logLines.filter((line) => line.includes(text))).toEqual([]);
      }
      expect(logLines.filter((line) => BEARER_SHAPED.test(line))).toEqual([]);
    });

    it("logs an unexpected error of the builder (not its HelmBuildError) at error, by its name only: 503, nothing counted or audited (Ruling 48)", async () => {
      const world = await aKubernetesWorld();
      const { id, secret } = await madeHelm(world);
      overrides.helmValuesYamlFails = new TypeError(`unexpected-canary ${VALUE}`);
      await expectRefused(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE, id);
      overrides.helmValuesYamlFails = undefined;
      expect(logged().filter((line) => line.msg === "the Helm values link's values.yaml couldn't be built")).toEqual([
        {
          level: 50,
          time: expect.any(Number),
          pid: expect.any(Number),
          hostname: expect.any(String),
          msg: "the Helm values link's values.yaml couldn't be built",
          operation: "quickDeployHelmValues",
          organizationId: world.organizationId,
          fleetId: world.fleetId,
          groupId: world.gatewayId,
          linkId: id,
          error: "TypeError",
        },
      ]);
      expectRefusalLogged("quick_deploy_unavailable", world, id);
      for (const text of ["unexpected-canary", VALUE, QUOTED, secret, secret.slice(4)]) expect(logLines.filter((line) => line.includes(text))).toEqual([]);
      expect(logLines.filter((line) => BEARER_SHAPED.test(line))).toEqual([]);
      // The builder back: the link downloads.
      expect((await download(secret)).statusCode).toBe(200);
    });

    it("no log line holds the bearer or the secret", async () => {
      const world = await aKubernetesWorld();
      const { id, secret } = await madeHelm(world);
      const response = await download(secret);
      expect(response.statusCode).toBe(200);
      const { token } = parse(response.body) as { token: string };
      expect(logLines.length).toBeGreaterThan(1);
      expect(logged().some((line) => (line.req as { url?: string } | undefined)?.url === "/api/v1/quick-deploy/[redacted]")).toBe(true);
      for (const text of [token, secret, secret.slice(4), quickDeploySecretHash(secret), VALUE, QUOTED]) {
        expect(logLines.filter((line) => line.includes(text))).toEqual([]);
      }
      expect(logLines.filter((line) => BEARER_SHAPED.test(line))).toEqual([]);

      // A values file the builder refuses for an operator's field (here an endpoint outside its rule, set around
      // loadSettings; Ruling 48): 503 at error, the field and ids logged, never the revealed bearer or a value.
      logLines = [];
      const broken = await own({ settings: { ...settings, install: { ...settings.install, agentPublicUrl: "https://opamp.example/a b" } } });
      expectPlainText(await download(secret, { on: broken }), 503, DOWNLOAD_UNAVAILABLE_MESSAGE);
      expect((await stored(id)).download_count).toBe(1);
      expect(logged().filter((line) => line.msg === "the Helm values link's values.yaml couldn't be built")).toEqual([
        {
          level: 50,
          time: expect.any(Number),
          pid: expect.any(Number),
          hostname: expect.any(String),
          msg: "the Helm values link's values.yaml couldn't be built",
          operation: "quickDeployHelmValues",
          organizationId: world.organizationId,
          fleetId: world.fleetId,
          groupId: world.gatewayId,
          linkId: id,
          source: "operator",
          field: "endpoint",
        },
      ]);
      expectRefusalLogged("quick_deploy_unavailable", world, id);
      expect(reveals().length).toBeGreaterThan(1);
      for (const text of [secret, VALUE, QUOTED, "opamp.example/a b"]) expect(logLines.filter((line) => line.includes(text))).toEqual([]);
      expect(logLines.filter((line) => BEARER_SHAPED.test(line))).toEqual([]);

      // An opamp-server failure quoting the secret: never logged.
      logLines = [];
      before.revealEnrollmentToken = async () => {
        throw new Error(`a failure quoting ${secret}`);
      };
      expectPlainText(await download(secret), 503, DOWNLOAD_UNAVAILABLE_MESSAGE);
      before = {};
      expect((await stored(id)).download_count).toBe(1);
      expect(await downloads()).toHaveLength(1);
      expect(logLines.filter((line) => line.includes(secret) || BEARER_SHAPED.test(line))).toEqual([]);
      const audited = JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().execute());
      for (const text of [token, secret, quickDeploySecretHash(secret)]) expect(audited).not.toContain(text);
    });
  });
});
