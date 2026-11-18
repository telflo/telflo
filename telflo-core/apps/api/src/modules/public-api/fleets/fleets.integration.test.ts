import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import {
  containerCommand,
  helmQuickDeployCommand,
  QUICK_DEPLOY_URL_PATTERN,
  quickDeployCommands,
} from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import {
  addApiToken,
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  truncateAll,
} from "@telflo/db/testing";
import { TEST_RATE_LIMITS, type RateLimits } from "../../../http/rate-limits.js";
import { createInMemoryMailer } from "../../../mail/in-memory-mailer.js";
import { sha256Hex, type OpampServerClient } from "../../../opamp-server/client.js";
import { buildServer } from "../../../server.js";
import { loadSettings, type AppSettings } from "../../../settings.js";
import { UNCALLED_FILE_STORE } from "../../../testing/file-store.js";
import { useFakeOpampServer } from "../../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../../testing/otelcol-validator.js";
import { validatePublicReply } from "../../../testing/public-api-openapi.js";
import { openValues } from "../../quick-deploy/sealed-values.js";
import { quickDeploySecretHash } from "../../quick-deploy/secret.js";
import { apiTokenHash } from "../../service-accounts/tokens.js";

/*
 * The public surface's fleets, collector groups and install (D25 decision
 * 17's routes 17–23; decisions 15, 19, 35–38 and 53; Preflight rulings 10
 * and 11; Rulings 160 and 161), through the real server as the API's own
 * role, with the OpenAPI-checked fake as the opamp-server. Each route:
 * success through a real service account's token, a read token on a write
 * route 403, another organization's ids 404, and every reply checked
 * against the OpenAPI document.
 *
 * SECRETS: a `tf_` token, a fleet's bearers, a quick-deploy link's and a
 * Helm values link's secret are checked with boolean canaries only
 * (`includes`/`test`/`===` → a boolean), never toBe/toEqual/toContain on
 * anything that could hold one, so a failure prints none. Tokens are built
 * at run time by addApiToken; bearers come from the fake's reveal; the
 * install's command is compared with the shared builders' output for the
 * same inputs as a boolean.
 */

const opamp = useFakeOpampServer();

/** The routes as Fastify registers them, for the reply validator. */
const P = "/api/public/v1";
const ROUTE = {
  fleets: `${P}/fleets`,
  install: `${P}/fleets/:fleetId/install`,
  groups: `${P}/fleets/:fleetId/groups`,
  group: `${P}/fleets/:fleetId/groups/:groupId`,
} as const;

type Route = (typeof ROUTE)[keyof typeof ROUTE];

/** The collector version the catalogue offers with binaries for every Linux platform (the quick-deploy suites'). */
const COLLECTOR_VERSION = "0.162.0";

/** Two variables read, NGINX_ENV and BACKEND_API_KEY. */
const YAML = [
  "receivers:",
  "  filelog:",
  "    include: [/var/log/nginx/*.log]",
  "exporters:",
  "  otlphttp:",
  "    endpoint: https://backend.example.com",
  "    headers:",
  "      x-env: ${env:NGINX_ENV}",
  "      x-key: ${env:BACKEND_API_KEY}",
  "",
].join("\n");

/** A value the canaries look for in log lines and audit rows: configuration text, never logged. */
const VALUE = "prod-value-canary-5be1";

interface FleetBody {
  id: string;
  label: string;
  type: string;
  status?: string;
  createdAt?: string;
  tokenId?: string;
  tokenExpiresAt?: string | null;
}

interface GroupBody {
  id: string;
  fleetId: string;
  name: string;
  isDefault: boolean;
  role: string | null;
  namespace: string | null;
  replicas: number | null;
  assignedPublishedVersionId: string | null;
  configurationId: string | null;
  versionNumber: number | null;
}

interface InstallBody {
  fleetId: string;
  fleetType: string;
  platform: string;
  groupId: string;
  groupName: string;
  command: string;
  notes: string[];
  expiresAt: string | null;
}

describe("the public fleets, groups and install routes (D25 routes 17-23)", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let logLines: string[] = [];
  /** The operations the server asked the opamp-server for, and every bearer it was answered (a fresh one each reveal: the fake's). */
  let operations: string[] = [];
  let bearers: string[] = [];
  /** Operations the fake is made to fail (a throw: the platform's one 503). */
  let failing = new Set<string>();

  /** The fake, as the server calls it, recording its operations and the bearers it answers (kept in memory, never printed). */
  const serverClient = new Proxy({} as OpampServerClient, {
    get(_target, property) {
      const operation = property as keyof OpampServerClient;
      return async (...args: unknown[]) => {
        operations.push(operation);
        if (failing.has(operation)) throw new Error("the opamp-server is down (the test's)");
        const result = await (opamp.client[operation] as (...given: unknown[]) => Promise<unknown>)(...args);
        const answer = result as { kind?: string; token?: { bearer?: string }; tokens?: { default: { bearer: string }; rotate: { bearer: string } } };
        if (answer.kind === "revealed" && typeof answer.token?.bearer === "string") bearers.push(answer.token.bearer);
        if (answer.kind === "created" && answer.tokens !== undefined) bearers.push(answer.tokens.default.bearer, answer.tokens.rotate.bearer);
        return result;
      };
    },
  });

  /** The bearer the server's one reveal since the mark answered. */
  const revealedSince = (mark: number) => {
    const revealed = bearers.slice(mark);
    // The length only: a failure must never print a bearer.
    expect(revealed.length).toBe(1);
    return revealed[0]!;
  };

  const build = (rateLimits: RateLimits = TEST_RATE_LIMITS) => {
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
        rateLimits,
        runAfterResponse: (task) => void task(),
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
  };

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    server = build();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    logLines = [];
    operations = [];
    bearers = [];
    failing = new Set();
  });

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  /** An admin person of a new group organization, and its service account with a read token and a write token. */
  const organization = async () => {
    const at = new Date(Date.now() - 60_000);
    const admin = await createUserWithOrganization(ownerDb, { user: { email: `person-${randomUUID()}@example.com` } });
    const { organization: group } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    const { user: account } = await addServiceAccount(ownerDb, { organizationId: group.id, createdAt: at });
    const tokenOf = async (access: "read" | "write") =>
      (await addApiToken(ownerDb, { organizationId: group.id, serviceAccountUserId: account.id, created_at: at, access })).token;
    return { id: group.id, admin: admin.user, accountUserId: account.id, read: await tokenOf("read"), write: await tokenOf("write") };
  };

  type Organization = Awaited<ReturnType<typeof organization>>;

  interface CallOptions {
    fleetId?: string;
    groupId?: string;
    query?: string;
    payload?: unknown;
    on?: FastifyInstance;
  }

  /** A request to `route` with `token`; the reply's canary first, then the reply checked against the OpenAPI document (its errors name no value). */
  const call = async (method: string, route: Route, token: string, options: CallOptions = {}) => {
    const url =
      route.replace(":fleetId", encodeURIComponent(options.fleetId ?? "")).replace(":groupId", encodeURIComponent(options.groupId ?? "")) +
      (options.query ?? "");
    const response = await (options.on ?? server).inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    });
    expect(holdsToken(response.body, token)).toBe(false);
    const body: unknown = response.body === "" ? undefined : response.json();
    expect(validatePublicReply(method, route, response.statusCode, body).errors).toEqual([]);
    return response;
  };

  const expectRefusal = (response: LightMyRequestResponse, statusCode: number, code: string) => {
    // `error?.`: a reply that isn't a refusal fails on its status, never on reading it (its body may hold a secret: not printed).
    expect({ status: response.statusCode, code: response.json<{ error?: { code: string } }>().error?.code }).toEqual({ status: statusCode, code });
  };

  /** A refusal's details: on the public surface `[{ path, code }]` or `[{ path, message }]` only (Rulings 175 and 187). */
  const detailsOf = (response: LightMyRequestResponse): unknown => response.json<{ error?: { details?: unknown } }>().error?.details;

  let labels = 0;

  /** A fleet made through the public API. */
  const fleetOf = async (org: Organization, type: "server" | "kubernetes-supervisor" = "server") => {
    const response = await call("POST", ROUTE.fleets, org.write, { payload: { label: `edge-${++labels}-${randomUUID()}`, type } });
    expect(response.statusCode).toBe(201);
    return response.json<FleetBody>();
  };

  /** The fleet's groups, through the public API. */
  const groupsOf = async (org: Organization, fleetId: string) =>
    (await call("GET", ROUTE.groups, org.read, { fleetId })).json<{ items: GroupBody[] }>().items;

  /** A configuration of the account's, its versions published (in the platform and the fake opamp-server) as asked. */
  const configurationOf = async (org: Organization, versions: Array<{ published: boolean; yaml?: string }>, createdBy = org.accountUserId) => {
    const configuration = await addConfiguration(ownerDb, { organizationId: org.id, created_by_user_id: createdBy, name: `nginx-${randomUUID()}` });
    const made = [];
    for (const [index, wanted] of versions.entries()) {
      const yaml = wanted.yaml ?? YAML;
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: org.id,
        created_by_user_id: createdBy,
        version_number: index + 1,
        yaml_content: yaml,
        collector_distribution: "otelcol-contrib",
        collector_version: COLLECTOR_VERSION,
        ...(wanted.published && { publishedAt: new Date(), publishedByUserId: createdBy }),
      });
      if (wanted.published) {
        const result = await opamp.client.postPublication(org.id, version.publication_id as string, {
          configuration: { id: configuration.id, name: configuration.name },
          version: { id: version.id, number: version.version_number, label: null },
          yaml,
          sha256: sha256Hex(yaml),
          publishedBy: null,
          publishedAt: new Date().toISOString(),
          collector: { distribution: "otelcol-contrib", version: COLLECTOR_VERSION },
        });
        expect(result.kind).toBe("created");
      }
      made.push(version);
    }
    return { id: configuration.id, versions: made };
  };

  /** The fleet's default token's id, from the fake. */
  const defaultTokenIdOf = async (organizationId: string, fleetId: string) => {
    const listed = await opamp.client.listEnrollmentTokens(organizationId, fleetId);
    if (listed.kind !== "listed") throw new Error("the fake listed no tokens");
    return listed.tokens.find((each) => each.kind === "default")!.id;
  };

  /** The reveals' audit rows of the organization. */
  const revealAudits = (organizationId: string) =>
    ownerDb
      .selectFrom("audit_events")
      .select(["action", "subject_type", "subject_id", "metadata", "actor_user_id"])
      .where("organization_id", "=", organizationId)
      .where("action", "=", "enrollment_token.revealed")
      .orderBy("id")
      .execute();

  const auditText = async (organizationId: string) =>
    JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().where("organization_id", "=", organizationId).execute());

  /** The link's url in a command (its curl config line), or undefined: never printed. */
  const linkOf = (command: string): string | undefined => /printf 'url = "%s"\\n' '([^']+)'/.exec(command)?.[1];

  /** A server fleet whose Default group is assigned a published version. */
  const serverWorld = async (org?: Organization) => {
    const owner = org ?? (await organization());
    const fleet = await fleetOf(owner);
    const configuration = await configurationOf(owner, [{ published: true }]);
    const [defaultGroup] = await groupsOf(owner, fleet.id);
    const assigned = await call("PATCH", ROUTE.group, owner.write, {
      fleetId: fleet.id,
      groupId: defaultGroup!.id,
      payload: { configurationId: configuration.id, versionNumber: 1 },
    });
    expect(assigned.statusCode).toBe(200);
    logLines = [];
    return { org: owner, fleet, configuration, defaultGroupId: defaultGroup!.id };
  };

  /** A Kubernetes fleet whose only group, the Agent, is assigned a published version. */
  const kubernetesWorld = async (org?: Organization) => {
    const owner = org ?? (await organization());
    const fleet = await fleetOf(owner, "kubernetes-supervisor");
    const configuration = await configurationOf(owner, [{ published: true }]);
    const [agent] = await groupsOf(owner, fleet.id);
    expect(
      (await call("PATCH", ROUTE.group, owner.write, { fleetId: fleet.id, groupId: agent!.id, payload: { configurationId: configuration.id, versionNumber: 1 } }))
        .statusCode,
    ).toBe(200);
    logLines = [];
    return { org: owner, fleet, configuration, agentId: agent!.id };
  };

  /** Whether any log line holds any of `secrets` (a boolean: none is printed). */
  const loggedAny = (secrets: readonly string[]) => logLines.some((line) => secrets.some((secret) => line.includes(secret)));

  // ---------------------------------------------------------------------------

  describe("POST /fleets (route 17)", () => {
    it("creates the fleet with the rotate token's expiry, answering its id and NO bearer, no-store; a read token is 403 and makes nothing", async () => {
      const org = await organization();
      const before = Date.now();
      const response = await call("POST", ROUTE.fleets, org.write, { payload: { label: "edge prod", type: "server", expiresIn: "180d" } });
      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const created = response.json<FleetBody>();
      expect({ label: created.label, type: created.type }).toEqual({ label: "edge prod", type: "server" });
      const expiresAt = Date.parse(created.tokenExpiresAt!);
      expect(expiresAt >= before + 180 * 86_400_000 && expiresAt <= Date.now() + 180 * 86_400_000).toBe(true);
      const listed = await opamp.client.listEnrollmentTokens(org.id, created.id);
      if (listed.kind !== "listed") throw new Error("the fake listed no tokens");
      expect(created.tokenId).toBe(listed.tokens.find((token) => token.kind === "rotate")!.id);
      // No bearer in the reply: the canary over both of the fleet's, as the opamp-server answered them to the create.
      expect(operations.filter((operation) => operation === "createFleet")).toHaveLength(1);
      expect(bearers.length).toBe(2);
      expect(bearers.some((bearer) => response.body.includes(bearer))).toBe(false);
      expect(loggedAny(bearers)).toBe(false);

      // `never` when left out; a Kubernetes fleet.
      const never = await call("POST", ROUTE.fleets, org.write, { payload: { label: "cluster prod", type: "kubernetes-supervisor" } });
      expect(never.json<FleetBody>().tokenExpiresAt).toBeNull();

      const refused = await call("POST", ROUTE.fleets, org.read, { payload: { label: "edge two", type: "server" } });
      expectRefusal(refused, 403, "insufficient_access");
      const page = await call("GET", ROUTE.fleets, org.read);
      expect(page.json<{ items: FleetBody[] }>().items).toHaveLength(2);
    });

    it("answers a label the organization's fleets have 409 fleet_label_taken; another organization's same label is fine; an unknown type and an unknown expiry are 400", async () => {
      const org = await organization();
      const other = await organization();
      expect((await call("POST", ROUTE.fleets, org.write, { payload: { label: "edge", type: "server" } })).statusCode).toBe(201);
      expectRefusal(await call("POST", ROUTE.fleets, org.write, { payload: { label: "edge", type: "kubernetes-supervisor" } }), 409, "fleet_label_taken");
      expect((await call("POST", ROUTE.fleets, other.write, { payload: { label: "edge", type: "server" } })).statusCode).toBe(201);
      expectRefusal(await call("POST", ROUTE.fleets, org.write, { payload: { label: "edge 2", type: "server-supervisor" } }), 400, "invalid_request");
      expectRefusal(await call("POST", ROUTE.fleets, org.write, { payload: { label: "edge 2", type: "server", expiresIn: "3y" } }), 400, "invalid_request");
      expectRefusal(await call("POST", ROUTE.fleets, org.write, { payload: { label: "edge 2", type: "server", id: randomUUID() } }), 400, "invalid_request");
    });
    it("spends the bearer budget, as the browser's create (Preflight ruling 11): with one reply a minute, the second create is 429 and makes nothing", async () => {
      const limited = build({ ...TEST_RATE_LIMITS, fleetBearerRepliesPerUser: { max: 1, windowMs: 60_000 } });
      await limited.ready();
      try {
        const org = await organization();
        expect((await call("POST", ROUTE.fleets, org.write, { payload: { label: "edge one", type: "server" }, on: limited })).statusCode).toBe(201);
        const second = await call("POST", ROUTE.fleets, org.write, { payload: { label: "edge two", type: "server" }, on: limited });
        expectRefusal(second, 429, "rate_limited");
        expect(second.headers["retry-after"]).toBeDefined();
        expect(operations.filter((operation) => operation === "createFleet").length).toBe(1);
        expect((await call("GET", ROUTE.fleets, org.read)).json<{ items: FleetBody[] }>().items.map((fleet) => fleet.label)).toEqual(["edge one"]);
      } finally {
        await limited.close();
      }
    });
  });

  describe("GET /fleets (route 18)", () => {
    it("pages the organization's fleets, newest first, with the summary's fields; not another organization's; a cursor that isn't one is 400", async () => {
      const org = await organization();
      const other = await organization();
      const made = [];
      for (let index = 0; index < 3; index += 1) made.push((await fleetOf(org)).id);
      await fleetOf(other);
      const first = await call("GET", ROUTE.fleets, org.read, { query: "?limit=2" });
      expect(first.statusCode).toBe(200);
      const firstPage = first.json<{ items: FleetBody[]; nextCursor: string | null }>();
      expect(firstPage.items).toHaveLength(2);
      expect(Object.keys(firstPage.items[0]!).sort()).toEqual(["createdAt", "id", "label", "status", "type"]);
      expect(firstPage.items[0]).toMatchObject({ type: "server", status: "active" });
      expect(typeof firstPage.nextCursor).toBe("string");
      const second = await call("GET", ROUTE.fleets, org.read, { query: `?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}` });
      const secondPage = second.json<{ items: FleetBody[]; nextCursor: string | null }>();
      expect(secondPage.nextCursor).toBeNull();
      expect([...firstPage.items, ...secondPage.items].map((fleet) => fleet.id).sort()).toEqual([...made].sort());
      const badCursor = await call("GET", ROUTE.fleets, org.read, { query: "?cursor=nonsense" });
      expectRefusal(badCursor, 400, "invalid_request");
      // The service's own refusal in fixed words (Ruling 187), not the browser's Zod-like entry.
      expect(detailsOf(badCursor)).toEqual([{ path: ["cursor"], message: "Not a cursor of this list's: reload the list." }]);
      const overLimit = await call("GET", ROUTE.fleets, org.read, { query: "?limit=101" });
      expectRefusal(overLimit, 400, "invalid_request");
      expect(detailsOf(overLimit)).toEqual([{ path: ["limit"], code: "too_big" }]);
      expectRefusal(await call("GET", ROUTE.fleets, org.read, { query: "?status=active" }), 400, "invalid_request");
    });
  });

  // ---------------------------------------------------------------------------

  describe("the groups (routes 20-23)", () => {
    it("lists a server fleet's groups with their assignment by configuration and number; reads one; another organization's fleet or group, and a malformed id, are 404", async () => {
      const { org, fleet, configuration, defaultGroupId } = await serverWorld();
      const other = await organization();
      const listed = await call("GET", ROUTE.groups, org.read, { fleetId: fleet.id });
      expect(listed.statusCode).toBe(200);
      const page = listed.json<{ items: GroupBody[]; nextCursor: null }>();
      expect(page.nextCursor).toBeNull();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id: defaultGroupId,
        fleetId: fleet.id,
        name: "Default",
        isDefault: true,
        role: null,
        namespace: null,
        replicas: null,
        assignedPublishedVersionId: configuration.versions[0]!.publication_id,
        configurationId: configuration.id,
        versionNumber: 1,
      });
      const one = await call("GET", ROUTE.group, org.read, { fleetId: fleet.id, groupId: defaultGroupId });
      expect(one.json<GroupBody>()).toEqual(page.items[0]);

      expectRefusal(await call("GET", ROUTE.groups, other.read, { fleetId: fleet.id }), 404, "fleet_not_found");
      expectRefusal(await call("GET", ROUTE.group, other.read, { fleetId: fleet.id, groupId: defaultGroupId }), 404, "fleet_not_found");
      expectRefusal(await call("GET", ROUTE.groups, org.read, { fleetId: "not-a-uuid" }), 404, "fleet_not_found");
      expectRefusal(await call("GET", ROUTE.group, org.read, { fleetId: fleet.id, groupId: "not-a-uuid" }), 404, "collector_group_not_found");
      expectRefusal(await call("GET", ROUTE.group, org.read, { fleetId: fleet.id, groupId: randomUUID() }), 404, "collector_group_not_found");
    });

    it("creates a server fleet's group assigned a published version; a draft is 422, another person's draft and another organization's configuration 404, a taken name 409, Kubernetes fields 400, a read token 403", async () => {
      const { org, fleet, configuration } = await serverWorld();
      const other = await organization();
      const created = await call("POST", ROUTE.groups, org.write, {
        fleetId: fleet.id,
        payload: { name: "edge-east", configurationId: configuration.id, versionNumber: 1 },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json<GroupBody>()).toMatchObject({ name: "edge-east", isDefault: false, role: null, configurationId: configuration.id, versionNumber: 1 });

      const draft = await configurationOf(org, [{ published: true }, { published: false }]);
      expectRefusal(
        await call("POST", ROUTE.groups, org.write, { fleetId: fleet.id, payload: { name: "drafts", configurationId: draft.id, versionNumber: 2 } }),
        422,
        "configuration_version_not_published",
      );
      expectRefusal(
        await call("POST", ROUTE.groups, org.write, { fleetId: fleet.id, payload: { name: "drafts", configurationId: draft.id, versionNumber: 9 } }),
        404,
        "configuration_version_not_found",
      );
      const othersDraft = await configurationOf(org, [{ published: false }], org.admin.id);
      expectRefusal(
        await call("POST", ROUTE.groups, org.write, { fleetId: fleet.id, payload: { name: "theirs", configurationId: othersDraft.id, versionNumber: 1 } }),
        404,
        "configuration_not_found",
      );
      // Another organization's (unknown to the opamp-server: a draft there).
      const elsewhere = await configurationOf(other, [{ published: false }]);
      expectRefusal(
        await call("POST", ROUTE.groups, org.write, { fleetId: fleet.id, payload: { name: "elsewhere", configurationId: elsewhere.id, versionNumber: 1 } }),
        404,
        "configuration_not_found",
      );
      expectRefusal(
        await call("POST", ROUTE.groups, other.write, { fleetId: fleet.id, payload: { name: "theirs", configurationId: elsewhere.id, versionNumber: 1 } }),
        404,
        "fleet_not_found",
      );
      expectRefusal(
        await call("POST", ROUTE.groups, org.write, { fleetId: fleet.id, payload: { name: "edge-east", configurationId: configuration.id, versionNumber: 1 } }),
        409,
        "collector_group_name_taken",
      );
      for (const extra of [{ role: "gateway" }, { namespace: "tracing" }, { replicas: 2 }]) {
        const refused = await call("POST", ROUTE.groups, org.write, {
          fleetId: fleet.id,
          payload: { name: "k8s", configurationId: configuration.id, versionNumber: 1, ...extra },
        });
        expectRefusal(refused, 400, "invalid_request");
        // The route's own refusal: `{ path, message }` (Ruling 187).
        expect(detailsOf(refused)).toEqual([{ path: Object.keys(extra), message: "Only a kubernetes-supervisor fleet's groups take it." }]);
      }
      expectRefusal(
        await call("POST", ROUTE.groups, org.read, { fleetId: fleet.id, payload: { name: "read", configurationId: configuration.id, versionNumber: 1 } }),
        403,
        "insufficient_access",
      );
      expect((await groupsOf(org, fleet.id)).map((group) => group.name).sort()).toEqual(["Default", "edge-east"]);
    });

    it("creates a Kubernetes fleet's Cluster and gateway pools with their role, namespace and replicas; a role that isn't the name's, replicas off a gateway, a bad gateway name are 400", async () => {
      const { org, fleet, configuration, agentId } = await kubernetesWorld();
      const agent = await call("GET", ROUTE.group, org.read, { fleetId: fleet.id, groupId: agentId });
      expect(agent.json<GroupBody>()).toMatchObject({ isDefault: true, role: "node", namespace: "telflo-collectors", replicas: null });
      const gateway = await call("POST", ROUTE.groups, org.write, {
        fleetId: fleet.id,
        payload: { name: "traces-sampling", configurationId: configuration.id, versionNumber: 1, role: "gateway", namespace: "tracing", replicas: 3 },
      });
      expect(gateway.statusCode).toBe(201);
      expect(gateway.json<GroupBody>()).toMatchObject({ role: "gateway", namespace: "tracing", replicas: 3 });
      const cluster = await call("POST", ROUTE.groups, org.write, { fleetId: fleet.id, payload: { name: "cluster", configurationId: configuration.id, versionNumber: 1 } });
      expect(cluster.json<GroupBody>()).toMatchObject({ role: "cluster", namespace: "telflo-collectors", replicas: null });
      const plain = await call("POST", ROUTE.groups, org.write, { fleetId: fleet.id, payload: { name: "metrics", configurationId: configuration.id, versionNumber: 1 } });
      expect(plain.json<GroupBody>()).toMatchObject({ role: "gateway", namespace: "telflo-collectors", replicas: 1 });

      for (const payload of [
        { name: "logs", role: "cluster" },
        { name: "logs", role: "node" },
        { name: "cluster-two", replicas: 2, role: "cluster" },
        { name: "Not_A_Label" },
      ]) {
        expectRefusal(
          await call("POST", ROUTE.groups, org.write, { fleetId: fleet.id, payload: { configurationId: configuration.id, versionNumber: 1, ...payload } }),
          400,
          "invalid_request",
        );
      }
    });

    it("merges a PATCH: a configuration and a number reassign, a number alone keeps the configuration, null clears, a configuration without a number is 400", async () => {
      const { org, fleet, configuration, defaultGroupId } = await serverWorld();
      const second = await configurationOf(org, [{ published: true }, { published: true }, { published: true }]);
      const patch = (payload: unknown) => call("PATCH", ROUTE.group, org.write, { fleetId: fleet.id, groupId: defaultGroupId, payload });

      const reassigned = await patch({ configurationId: second.id, versionNumber: 2 });
      expect(reassigned.statusCode).toBe(200);
      expect(reassigned.json<GroupBody>()).toMatchObject({
        configurationId: second.id,
        versionNumber: 2,
        assignedPublishedVersionId: second.versions[1]!.publication_id,
      });
      const moved = await patch({ versionNumber: 3 });
      expect(moved.json<GroupBody>()).toMatchObject({ configurationId: second.id, versionNumber: 3 });
      const cleared = await patch({ configurationId: null });
      expect(cleared.json<GroupBody>()).toMatchObject({ configurationId: null, versionNumber: null, assignedPublishedVersionId: null });

      expectRefusal(await patch({ versionNumber: 1 }), 400, "invalid_request");
      expectRefusal(await patch({ configurationId: configuration.id }), 400, "invalid_request");
      expectRefusal(await patch({ configurationId: null, versionNumber: 1 }), 400, "invalid_request");
      expectRefusal(await patch({}), 400, "invalid_request");
      expectRefusal(await patch({ role: "node" }), 400, "invalid_request");
      expectRefusal(await patch({ namespace: "tracing" }), 400, "invalid_request");
      expectRefusal(await patch({ name: "Default 2", configurationId: configuration.id, versionNumber: 1 }), 409, "collector_group_is_default");

      // A rename of another group, with an assignment; a read token 403; another organization 404.
      const created = await call("POST", ROUTE.groups, org.write, { fleetId: fleet.id, payload: { name: "west", configurationId: configuration.id, versionNumber: 1 } });
      const groupId = created.json<GroupBody>().id;
      const renamed = await call("PATCH", ROUTE.group, org.write, { fleetId: fleet.id, groupId, payload: { name: "west-2" } });
      expect(renamed.json<GroupBody>()).toMatchObject({ name: "west-2", configurationId: configuration.id, versionNumber: 1 });
      expectRefusal(await call("PATCH", ROUTE.group, org.read, { fleetId: fleet.id, groupId, payload: { name: "west-3" } }), 403, "insufficient_access");
      const other = await organization();
      expectRefusal(await call("PATCH", ROUTE.group, other.write, { fleetId: fleet.id, groupId, payload: { name: "west-3" } }), 404, "fleet_not_found");
    });

    it("merges a Kubernetes group's namespace and replicas into its settings, keeping its volumes and other keys; null sets each back; a rename is 409", async () => {
      const { org, fleet, configuration, agentId } = await kubernetesWorld();
      const gateway = await call("POST", ROUTE.groups, org.write, {
        fleetId: fleet.id,
        payload: { name: "traces", configurationId: configuration.id, versionNumber: 1, namespace: "tracing", replicas: 2 },
      });
      const gatewayId = gateway.json<GroupBody>().id;
      // A volume and a key of another client's, written straight to the opamp-server.
      const volume = { hostPath: "/var/lib/data", hostPathType: "Directory", mountPath: "/data", readOnly: true };
      const written = await opamp.client.updateCollectorGroup(org.id, fleet.id, gatewayId, {
        annotations: { other: { kept: true }, telflo: { kubernetes: { role: "gateway", namespace: "tracing", replicas: 2, volumes: [volume] } } },
      });
      expect(written.kind).toBe("updated");
      const patch = (groupId: string, payload: unknown) => call("PATCH", ROUTE.group, org.write, { fleetId: fleet.id, groupId, payload });

      const scaled = await patch(gatewayId, { replicas: 5 });
      expect(scaled.json<GroupBody>()).toMatchObject({ namespace: "tracing", replicas: 5 });
      const moved = await patch(gatewayId, { namespace: "sampling", replicas: null });
      expect(moved.json<GroupBody>()).toMatchObject({ namespace: "sampling", replicas: 1 });
      const stored = await opamp.client.getCollectorGroup(org.id, fleet.id, gatewayId);
      if (stored.kind !== "found") throw new Error("the fake lost the group");
      expect(stored.group.annotations).toEqual({ other: { kept: true }, telflo: { kubernetes: { role: "gateway", namespace: "sampling", volumes: [volume] } } });

      const agent = await patch(agentId, { namespace: "nodes" });
      expect(agent.json<GroupBody>()).toMatchObject({ role: "node", namespace: "nodes", replicas: null, configurationId: configuration.id });
      expect((await patch(agentId, { namespace: null })).json<GroupBody>().namespace).toBe("telflo-collectors");
      expectRefusal(await patch(agentId, { replicas: 2 }), 400, "invalid_request");
      expectRefusal(await patch(gatewayId, { name: "renamed" }), 409, "collector_group_name_fixed");
    });
  });

  // ---------------------------------------------------------------------------

  describe("POST /fleets/{fleetId}/install (route 19)", () => {
    it("docker: the container command the dialog builds, with the default token's bearer, no-store; audited as a reveal with via and platform; no bearer in a log line or an audit row", async () => {
      const { org, fleet, defaultGroupId } = await serverWorld();
      const mark = bearers.length;
      const response = await call("POST", ROUTE.install, org.write, {
        fleetId: fleet.id,
        payload: { platform: "docker", displayName: "  edge 1 ", env: [{ name: "NGINX_ENV", value: VALUE }] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<InstallBody>();
      expect({ ...body, command: undefined, notes: undefined }).toEqual({
        fleetId: fleet.id,
        fleetType: "server",
        platform: "docker",
        groupId: defaultGroupId,
        groupName: "Default",
        command: undefined,
        notes: undefined,
        expiresAt: null,
      });
      // The variable not set is named in the notes (the reply only).
      expect(body.notes.some((note) => note.includes("BACKEND_API_KEY"))).toBe(true);
      const tokenId = await defaultTokenIdOf(org.id, fleet.id);
      // The one reveal the install made: its bearer is the command's.
      const bearer = revealedSince(mark);
      const expected = containerCommand({
        facts: {
          imageTag: `${settings.install.collectorImageRepository}:${COLLECTOR_VERSION}`,
          endpoint: settings.install.agentPublicUrl,
          allowInsecureConnections: settings.install.allowInsecureConnections,
          groupId: defaultGroupId,
          mounts: [],
        },
        bearer,
        displayName: "edge 1",
        env: [{ name: "NGINX_ENV", value: VALUE }],
      });
      // The canary: never toBe on the command (it holds the bearer).
      expect(body.command === expected).toBe(true);

      const audits = await revealAudits(org.id);
      expect(audits.length).toBe(1);
      const metadata = audits[0]!.metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(["fleetId", "kind", "platform", "tokenId", "via"]);
      expect(metadata.via === "public_api_install" && metadata.platform === "docker" && metadata.kind === "default").toBe(true);
      expect(metadata.tokenId === tokenId && metadata.fleetId === fleet.id && audits[0]!.subject_id === tokenId).toBe(true);
      expect(audits[0]!.actor_user_id).toBe(org.accountUserId);
      const audited = await auditText(org.id);
      expect(audited.includes(bearer) || audited.includes(VALUE)).toBe(false);
      expect(loggedAny([bearer, VALUE, org.write.slice(3)])).toBe(false);
    });

    it("linux: a new 24-hour quick-deploy link and the All In One Quick Deploy command with the bearer and the link, no-store; the reveal audited with via and platform; neither secret in a log line or an audit row", async () => {
      const { org, fleet, defaultGroupId } = await serverWorld();
      const before = Date.now();
      const mark = bearers.length;
      const response = await call("POST", ROUTE.install, org.write, {
        fleetId: fleet.id,
        payload: { platform: "linux", arch: "arm64", rootPath: "/opt/telflo/", systemd: true, env: [{ name: "BACKEND_API_KEY", value: VALUE }] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<InstallBody>();
      expect({ platform: body.platform, groupId: body.groupId, fleetType: body.fleetType }).toEqual({ platform: "linux", groupId: defaultGroupId, fleetType: "server" });
      const expiresAt = Date.parse(body.expiresAt!);
      expect(expiresAt >= before + 86_400_000 - 1000 && expiresAt <= Date.now() + 86_400_000).toBe(true);

      const url = linkOf(body.command);
      expect(url !== undefined && QUICK_DEPLOY_URL_PATTERN.test(url)).toBe(true);
      const secret = url!.slice(url!.lastIndexOf("/") + 1);
      const links = await ownerDb.selectFrom("quick_deploy_links").selectAll().where("fleet_id", "=", fleet.id).execute();
      expect(links.length).toBe(1);
      expect(links[0]!.secret_hash === quickDeploySecretHash(secret)).toBe(true);
      expect(links[0]!.choices).toMatchObject({ method: "all-in-one", arch: "arm64", rootPath: "/opt/telflo", systemd: true, envNames: ["BACKEND_API_KEY"] });
      const tokenId = await defaultTokenIdOf(org.id, fleet.id);
      expect(links[0]!.default_token_id).toBe(tokenId);
      const bearer = revealedSince(mark);
      const expected = quickDeployCommands({ url: url!, rootPath: "/opt/telflo", bearer, displayName: "", systemd: true });
      expect(body.command === expected).toBe(true);

      const audits = await revealAudits(org.id);
      expect(audits.length).toBe(1);
      const metadata = audits[0]!.metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(["fleetId", "kind", "platform", "tokenId", "via"]);
      expect(metadata.via === "public_api_install" && metadata.platform === "linux" && metadata.tokenId === tokenId).toBe(true);
      const audited = await auditText(org.id);
      expect([bearer, secret, VALUE].some((needle) => audited.includes(needle))).toBe(false);
      expect(loggedAny([bearer, secret, VALUE, org.write.slice(3)])).toBe(false);

      // In the foreground, with a display name: a fresh reveal.
      const secondMark = bearers.length;
      const foreground = await call("POST", ROUTE.install, org.write, {
        fleetId: fleet.id,
        payload: { platform: "linux", displayName: "vm 7", arch: "amd64", rootPath: "/etc/otelcol", systemd: false },
      });
      const second = foreground.json<InstallBody>();
      const secondUrl = linkOf(second.command)!;
      const secondBearer = revealedSince(secondMark);
      expect(second.command === quickDeployCommands({ url: secondUrl, rootPath: "/etc/otelcol", bearer: secondBearer, displayName: "vm 7", systemd: false })).toBe(true);
    });

    it("kubernetes: a new Helm values link and the Helm Quick Deploy command for the only group; a bearer-budget admission and the reveal's audit row with no reveal call; the link's secret in no log line or audit row", async () => {
      const { org, fleet, agentId } = await kubernetesWorld();
      const viewedBefore = await opamp.client.listEnrollmentTokenEvents(org.id, fleet.id, { limit: 100 });
      if (viewedBefore.kind !== "page") throw new Error("the fake listed no events");
      const mark = bearers.length;
      operations = [];
      const response = await call("POST", ROUTE.install, org.write, {
        fleetId: fleet.id,
        payload: { platform: "kubernetes", env: [{ name: "NGINX_ENV", value: VALUE }] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<InstallBody>();
      expect({ fleetType: body.fleetType, platform: body.platform, groupId: body.groupId, groupName: body.groupName }).toEqual({
        fleetType: "kubernetes-supervisor",
        platform: "kubernetes",
        groupId: agentId,
        groupName: "Default",
      });
      expect(typeof body.expiresAt).toBe("string");
      // No reveal (Ruling 161): no call, no bearer answered, and the opamp-server recorded no `viewed` event.
      expect(operations.includes("revealEnrollmentToken")).toBe(false);
      expect(bearers.length).toBe(mark);
      const viewedAfter = await opamp.client.listEnrollmentTokenEvents(org.id, fleet.id, { limit: 100 });
      if (viewedAfter.kind !== "page") throw new Error("the fake listed no events");
      expect(viewedAfter.page.events.filter((event) => event.event === "viewed")).toHaveLength(
        viewedBefore.page.events.filter((event) => event.event === "viewed").length,
      );

      const url = linkOf(body.command);
      expect(url !== undefined && QUICK_DEPLOY_URL_PATTERN.test(url)).toBe(true);
      const secret = url!.slice(url!.lastIndexOf("/") + 1);
      const links = await ownerDb.selectFrom("quick_deploy_links").selectAll().where("fleet_id", "=", fleet.id).execute();
      expect(links.length).toBe(1);
      expect(links[0]!.secret_hash === quickDeploySecretHash(secret)).toBe(true);
      const expected = helmQuickDeployCommand(url!, {
        release: "telflo-node",
        namespace: "telflo-collectors",
        chartReference: settings.install.helmChartReference,
        chartVersion: settings.install.helmChartVersion,
      });
      expect(body.command === expected).toBe(true);

      const audits = await revealAudits(org.id);
      expect(audits.length).toBe(1);
      const metadata = audits[0]!.metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(["fleetId", "kind", "platform", "tokenId", "via"]);
      expect(metadata.via === "public_api_install" && metadata.platform === "kubernetes" && metadata.tokenId === links[0]!.default_token_id).toBe(true);
      const audited = await auditText(org.id);
      expect([secret, VALUE].some((needle) => audited.includes(needle))).toBe(false);
      expect(loggedAny([secret, VALUE, org.write.slice(3)])).toBe(false);
    });

    it("trims each variable's value as the dialog does (Ruling 174): the command and the link's sealed values hold the trimmed one; a blank value is 400", async () => {
      const { org, fleet, defaultGroupId } = await serverWorld();
      const mark = bearers.length;
      const docker = await call("POST", ROUTE.install, org.write, {
        fleetId: fleet.id,
        payload: { platform: "docker", env: [{ name: "NGINX_ENV", value: "  spaced  " }] },
      });
      expect(docker.statusCode).toBe(200);
      const expected = containerCommand({
        facts: {
          imageTag: `${settings.install.collectorImageRepository}:${COLLECTOR_VERSION}`,
          endpoint: settings.install.agentPublicUrl,
          allowInsecureConnections: settings.install.allowInsecureConnections,
          groupId: defaultGroupId,
          mounts: [],
        },
        bearer: revealedSince(mark),
        displayName: "",
        env: [{ name: "NGINX_ENV", value: "spaced" }],
      });
      expect(docker.json<InstallBody>().command === expected).toBe(true);

      const linux = await call("POST", ROUTE.install, org.write, {
        fleetId: fleet.id,
        payload: { platform: "linux", arch: "amd64", rootPath: "/etc/otelcol", systemd: true, env: [{ name: "NGINX_ENV", value: "\t spaced \n" }] },
      });
      expect(linux.statusCode).toBe(200);
      const [link] = await ownerDb.selectFrom("quick_deploy_links").selectAll().where("fleet_id", "=", fleet.id).execute();
      const opened = openValues(
        settings.quickDeploy.keyRing,
        { ciphertext: Buffer.from(link!.env_ciphertext!), keyId: link!.env_key_id! },
        { organizationId: org.id, linkId: link!.id },
        ["NGINX_ENV"],
      );
      expect(opened.length === 1 && opened[0]!.name === "NGINX_ENV" && opened[0]!.value === "spaced").toBe(true);

      for (const value of ["   ", "\t \n"]) {
        expectRefusal(
          await call("POST", ROUTE.install, org.write, { fleetId: fleet.id, payload: { platform: "docker", env: [{ name: "NGINX_ENV", value }] } }),
          400,
          "invalid_request",
        );
      }
    });

    it("linux: a reveal that fails after the link is made revokes that link (audited as a revoke), and answers the 503: no live link is left, nothing revealed", async () => {
      const { org, fleet } = await serverWorld();
      failing = new Set(["revealEnrollmentToken"]);
      const payload = { platform: "linux", arch: "amd64", rootPath: "/etc/otelcol", systemd: true };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expectRefusal(await call("POST", ROUTE.install, org.write, { fleetId: fleet.id, payload }), 503, "fleets_unavailable");
      }
      const links = await ownerDb.selectFrom("quick_deploy_links").select(["id", "revoked_at", "revoked_by_user_id"]).where("fleet_id", "=", fleet.id).execute();
      expect(links.length).toBe(2);
      expect(links.every((link) => link.revoked_at !== null && link.revoked_by_user_id === org.accountUserId)).toBe(true);
      const revokes = await ownerDb
        .selectFrom("audit_events")
        .select(["subject_id", "metadata"])
        .where("organization_id", "=", org.id)
        .where("action", "=", "quick_deploy_link.revoked")
        .execute();
      expect(revokes.map((row) => row.subject_id).sort()).toEqual(links.map((link) => link.id).sort());
      expect(await revealAudits(org.id)).toHaveLength(0);
    });

    it("spends the bearer budget on every platform: with one reply a minute, the second install is 429, nothing made or revealed", async () => {
      const limited = build({ ...TEST_RATE_LIMITS, fleetBearerRepliesPerUser: { max: 1, windowMs: 60_000 } });
      await limited.ready();
      try {
        const serverFleet = await serverWorld();
        const kubernetes = await kubernetesWorld();
        const cases = [
          { world: serverFleet, payload: { platform: "docker" } },
          { world: serverFleet, payload: { platform: "linux", arch: "amd64", rootPath: "/etc/otelcol", systemd: true } },
          { world: kubernetes, payload: { platform: "kubernetes" } },
        ];
        for (const { world, payload } of cases) {
          // A fresh account in the world's organization: the budget is per person.
          const { user: account } = await addServiceAccount(ownerDb, { organizationId: world.org.id });
          const { token } = await addApiToken(ownerDb, { organizationId: world.org.id, serviceAccountUserId: account.id, access: "write" });
          const first = await call("POST", ROUTE.install, token, { fleetId: world.fleet.id, payload, on: limited });
          expect(first.statusCode).toBe(200);
          const linksBefore = (await ownerDb.selectFrom("quick_deploy_links").select("id").where("fleet_id", "=", world.fleet.id).execute()).length;
          const auditsBefore = (await revealAudits(world.org.id)).length;
          const second = await call("POST", ROUTE.install, token, { fleetId: world.fleet.id, payload, on: limited });
          expectRefusal(second, 429, "rate_limited");
          expect(second.headers["retry-after"]).toBeDefined();
          expect((await ownerDb.selectFrom("quick_deploy_links").select("id").where("fleet_id", "=", world.fleet.id).execute()).length).toBe(linksBefore);
          expect((await revealAudits(world.org.id)).length).toBe(auditsBefore);
        }
      } finally {
        await limited.close();
      }
    });

    it("refuses a read token 403 on every platform, nothing made, revealed or audited", async () => {
      const { org, fleet } = await serverWorld();
      const kubernetes = await kubernetesWorld(org);
      for (const [fleetId, payload] of [
        [fleet.id, { platform: "docker" }],
        [fleet.id, { platform: "linux", arch: "amd64", rootPath: "/etc/otelcol", systemd: true }],
        [kubernetes.fleet.id, { platform: "kubernetes" }],
      ] as const) {
        expectRefusal(await call("POST", ROUTE.install, org.read, { fleetId, payload }), 403, "insufficient_access");
      }
      expect(await ownerDb.selectFrom("quick_deploy_links").select("id").execute()).toHaveLength(0);
      expect(await revealAudits(org.id)).toHaveLength(0);
    });

    it("answers the existing refusal with the organization's install links off (linux and kubernetes); docker needs none", async () => {
      const { org, fleet } = await serverWorld();
      const kubernetes = await kubernetesWorld(org);
      await ownerDb.updateTable("organizations").set({ public_install_links_enabled: false }).where("id", "=", org.id).execute();
      expectRefusal(
        await call("POST", ROUTE.install, org.write, { fleetId: fleet.id, payload: { platform: "linux", arch: "amd64", rootPath: "/etc/otelcol", systemd: true } }),
        409,
        "public_install_links_disabled",
      );
      expectRefusal(await call("POST", ROUTE.install, org.write, { fleetId: kubernetes.fleet.id, payload: { platform: "kubernetes" } }), 409, "public_install_links_disabled");
      expect(await ownerDb.selectFrom("quick_deploy_links").select("id").execute()).toHaveLength(0);
      expect(await revealAudits(org.id)).toHaveLength(0);
      expect((await call("POST", ROUTE.install, org.write, { fleetId: fleet.id, payload: { platform: "docker" } })).statusCode).toBe(200);
    });

    it("refuses a platform that doesn't suit the fleet 422, several Kubernetes groups with none named 422 with their ids, another organization's fleet and an unknown group 404, a variable the version doesn't read 400", async () => {
      const { org, fleet } = await serverWorld();
      const kubernetes = await kubernetesWorld(org);
      const other = await organization();
      expectRefusal(await call("POST", ROUTE.install, org.write, { fleetId: fleet.id, payload: { platform: "kubernetes" } }), 422, "fleet_type_not_installable");
      expectRefusal(await call("POST", ROUTE.install, org.write, { fleetId: kubernetes.fleet.id, payload: { platform: "docker" } }), 422, "fleet_type_not_installable");

      const gateway = await call("POST", ROUTE.groups, org.write, {
        fleetId: kubernetes.fleet.id,
        payload: { name: "traces", configurationId: kubernetes.configuration.id, versionNumber: 1 },
      });
      const ambiguous = await call("POST", ROUTE.install, org.write, { fleetId: kubernetes.fleet.id, payload: { platform: "kubernetes" } });
      expectRefusal(ambiguous, 422, "collector_group_required");
      expect(ambiguous.json<{ error: { details: { groupIds: string[] } } }>().error.details.groupIds.sort()).toEqual(
        [kubernetes.agentId, gateway.json<GroupBody>().id].sort(),
      );
      const named = await call("POST", ROUTE.install, org.write, {
        fleetId: kubernetes.fleet.id,
        payload: { platform: "kubernetes", groupId: gateway.json<GroupBody>().id.toUpperCase() },
      });
      expect(named.statusCode).toBe(200);
      expect(named.json<InstallBody>().groupName).toBe("traces");

      expectRefusal(await call("POST", ROUTE.install, other.write, { fleetId: fleet.id, payload: { platform: "docker" } }), 404, "fleet_not_found");
      expectRefusal(await call("POST", ROUTE.install, org.write, { fleetId: "nope", payload: { platform: "docker" } }), 404, "fleet_not_found");
      expectRefusal(await call("POST", ROUTE.install, org.write, { fleetId: fleet.id, payload: { platform: "docker", groupId: randomUUID() } }), 404, "collector_group_not_found");
      const notOffered = await call("POST", ROUTE.install, org.write, {
        fleetId: fleet.id,
        payload: { platform: "docker", env: [{ name: "NGINX_ENV", value: "x" }, { name: "UNREAD", value: "x" }] },
      });
      expectRefusal(notOffered, 400, "invalid_request");
      // The service's refusal at the variable's index, never its name (Ruling 187: `{ path, message }`).
      expect(detailsOf(notOffered)).toEqual([{ path: ["env", 1, "name"], message: "Not a variable this group's published version reads." }]);
      expectRefusal(await call("POST", ROUTE.install, org.write, { fleetId: fleet.id, payload: { platform: "linux" } }), 400, "invalid_request");
      expectRefusal(await call("POST", ROUTE.install, org.write, { fleetId: fleet.id, payload: { platform: "docker", arch: "amd64" } }), 400, "invalid_request");
      expectRefusal(await call("POST", ROUTE.install, org.write, { fleetId: fleet.id, payload: { platform: "windows" } }), 400, "invalid_request");
      expectRefusal(await call("POST", ROUTE.install, org.write, { fleetId: fleet.id, payload: { platform: "docker", displayName: "it's" } }), 400, "invalid_request");
    });
  });
});
