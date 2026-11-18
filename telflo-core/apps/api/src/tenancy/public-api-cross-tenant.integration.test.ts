import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { createDb, createPool, type Database } from "@telflo/db";
import {
  addApiToken,
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addPersonalApiToken,
  addServiceAccount,
  addTestRun,
  createUserWithOrganization,
  truncateAll,
} from "@telflo/db/testing";
import { createFileStore } from "../file-store/create-file-store.js";
import { TEST_RATE_LIMITS } from "../http/rate-limits.js";
import { createInMemoryMailer } from "../mail/in-memory-mailer.js";
import { sha256Hex } from "../opamp-server/client.js";
import { publicApiRoutesOf } from "../modules/public-api/routes.js";
import { apiTokenHash } from "../modules/service-accounts/tokens.js";
import { createTestRunQueueSignal } from "../modules/test-runs/test-runs-dependencies.js";
import { buildServer } from "../server.js";
import { loadSettings } from "../settings.js";
import { useFakeOpampServer } from "../testing/opamp-server.js";
import { UNCALLED_TESTING, useFakeOtelcolTesting } from "../testing/otelcol-testing.js";
import { useFakeOtelcolValidator } from "../testing/otelcol-validator.js";
import { useFakeOttlEvaluator } from "../testing/ottl-evaluator.js";
import { validatePublicReply } from "../testing/public-api-openapi.js";

/*
 * The cross-tenant suite's public surface (D25 decision 53): every public
 * route the server registers, driven by organization B's tokens against
 * organization A's ids, on the real server as the API's own role. B's
 * callers are B's service account (a write token) and a person of B's with
 * a personal write token, sending `X-Telflo-Org: B`; each of A's ids
 * answers the resource's 404 (its id is another organization's, so it
 * isn't found), and an id of A's in a body of a route on B's own resource
 * the same. The same person naming A in `X-Telflo-Org` (they aren't A's
 * member) answers the one 403 organization_access_denied. Lists, `/whoami`
 * and `/orgs` never show A; creates land in B's organization, never A's.
 * The routes without an organization's id (the open routes, the global
 * flows, /validate and /ottl/lint, which store nothing) are listed with
 * their reason. The table is checked to cover every registered public route
 * (HEAD aside), and the last test reads A's resources back unchanged.
 *
 * Tokens are built at run time and never printed: every reply's canary (a
 * boolean) runs before anything else reads it.
 */

const opamp = useFakeOpampServer();
const validator = useFakeOtelcolValidator();
const tester = useFakeOtelcolTesting();
const evaluator = useFakeOttlEvaluator();

const P = "/api/public/v1";
const COLLECTOR_VERSION = "0.162.0";
const YAML = [
  "receivers:",
  "  otlp:",
  "    protocols:",
  "      http:",
  "exporters:",
  "  debug:",
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "",
].join("\n");
const TEXT_RULE = { kind: "contains_text", target: "output", pattern: "error" };

/** A tenant: an admin person, its service account's tokens, and the person's own write token. */
interface Tenant {
  id: string;
  adminId: string;
  accountUserId: string;
  read: string;
  write: string;
  personal: string;
}

/** A's resources, and B's own fleet (for the bodies naming A's ids on B's paths). */
interface World {
  a: Tenant & { configurationId: string; fleetId: string; groupId: string; yamlRunId: string; versionRunId: string };
  b: Tenant & { fleetId: string; groupId: string; kubernetesFleetId: string };
}

/** Who calls as organization B. */
interface Caller {
  label: string;
  token: (world: World) => string;
  organization?: (world: World) => string;
}

const B_CALLERS: readonly Caller[] = [
  { label: "B's service account", token: (world) => world.b.write },
  { label: "B's person (personal token, X-Telflo-Org: B)", token: (world) => world.b.personal, organization: (world) => world.b.id },
  // A service account's token ignores X-Telflo-Org (decision 23): still B's organization, A's ids still 404.
  { label: "B's service account (X-Telflo-Org: A, ignored)", token: (world) => world.b.write, organization: (world) => world.a.id },
];

/** B's person naming A, whose member they aren't. */
const B_PERSON_NAMING_A: Caller = {
  label: "B's person (personal token, X-Telflo-Org: A)",
  token: (world) => world.b.personal,
  organization: (world) => world.a.id,
};

interface Request {
  url: string;
  payload?: unknown;
}

/**
 * One row of the table. `route` is the route as registered (`METHOD url`);
 * a route may have several rows.
 *   - foreign: B's callers send A's ids (in the path or the body): 404, a
 *     resource's not-found code; B's person naming A: 403.
 *   - list: B's callers' list holds none of A's ids; B's person naming A: 403.
 *   - creates: B's callers' create lands in B (A's list never shows it).
 *   - identity: /whoami and /orgs name B, never A.
 *   - none: no organization's id reaches the route; the reason says why.
 */
type Row =
  | { kind: "foreign"; route: string; request: (world: World) => Request; what: string }
  | { kind: "list"; route: string; url: string; idsOf: (body: unknown) => string[]; foreignIds: (world: World) => string[] }
  | { kind: "creates"; route: string; request: () => Request; listUrl: string }
  | { kind: "identity"; route: string; url: string }
  | { kind: "none"; route: string; reason: string; namingA?: Request };

const itemsIds = (body: unknown) => ((body as { items?: Array<{ id: string }> }).items ?? []).map((item) => item.id);

const CONFIGURATION = `${P}/configurations/:configurationId`;
const VERSIONS = `${CONFIGURATION}/versions`;
const VERSION = `${VERSIONS}/:versionNumber`;
const FLEET = `${P}/fleets/:fleetId`;

const ROWS: readonly Row[] = [
  { kind: "none", route: `GET ${P}/health`, reason: "an open route: no token, no organization" },
  { kind: "none", route: `GET ${P}/openapi.json`, reason: "an open route: the document" },
  { kind: "none", route: `GET ${P}/docs`, reason: "an open route: the reference page's 301" },
  { kind: "none", route: `GET ${P}/docs/*`, reason: "an open route: the reference page and its assets" },
  { kind: "none", route: `POST ${P}/validate/anonymous`, reason: "an open route (D27): no token, no organization, a text checked for no one" },
  { kind: "identity", route: `GET ${P}/whoami`, url: `${P}/whoami` },
  { kind: "identity", route: `GET ${P}/orgs`, url: `${P}/orgs` },
  { kind: "list", route: `GET ${P}/configurations`, url: `${P}/configurations`, idsOf: itemsIds, foreignIds: (w) => [w.a.configurationId] },
  {
    kind: "creates",
    route: `POST ${P}/configurations`,
    request: () => ({ url: `${P}/configurations`, payload: { name: `b-${randomUUID()}`, yaml: YAML } }),
    listUrl: `${P}/configurations`,
  },
  { kind: "foreign", route: `GET ${CONFIGURATION}`, what: "A's configuration", request: (w) => ({ url: `${P}/configurations/${w.a.configurationId}` }) },
  {
    kind: "foreign",
    route: `PATCH ${CONFIGURATION}`,
    what: "A's configuration",
    request: (w) => ({ url: `${P}/configurations/${w.a.configurationId}`, payload: { name: "renamed-by-b" } }),
  },
  { kind: "foreign", route: `GET ${VERSIONS}`, what: "A's configuration", request: (w) => ({ url: `${P}/configurations/${w.a.configurationId}/versions` }) },
  {
    kind: "foreign",
    route: `POST ${VERSIONS}`,
    what: "A's configuration",
    request: (w) => ({ url: `${P}/configurations/${w.a.configurationId}/versions`, payload: { yaml: YAML } }),
  },
  { kind: "foreign", route: `GET ${VERSION}`, what: "A's version", request: (w) => ({ url: `${P}/configurations/${w.a.configurationId}/versions/1` }) },
  {
    kind: "foreign",
    route: `PATCH ${VERSION}`,
    what: "A's version",
    request: (w) => ({ url: `${P}/configurations/${w.a.configurationId}/versions/1`, payload: { yaml: YAML } }),
  },
  {
    kind: "foreign",
    route: `POST ${VERSION}/publish`,
    what: "A's version",
    request: (w) => ({ url: `${P}/configurations/${w.a.configurationId}/versions/1/publish` }),
  },
  {
    kind: "foreign",
    route: `GET ${VERSION}/validation-pipelines`,
    what: "A's version's pipelines",
    request: (w) => ({ url: `${P}/configurations/${w.a.configurationId}/versions/1/validation-pipelines` }),
  },
  {
    kind: "foreign",
    route: `PUT ${VERSION}/validation-pipelines/*`,
    what: "A's version's pipeline",
    request: (w) => ({
      url: `${P}/configurations/${w.a.configurationId}/versions/1/validation-pipelines/traces`,
      payload: { signal: "traces", rules: [TEXT_RULE] },
    }),
  },
  {
    kind: "none",
    route: `POST ${P}/validate`,
    reason: "takes text, no organization's id, and stores nothing",
    namingA: { url: `${P}/validate`, payload: { yaml: YAML } },
  },
  {
    kind: "none",
    route: `POST ${P}/ottl/lint`,
    reason: "takes expressions, no organization's id, and stores nothing",
    namingA: { url: `${P}/ottl/lint`, payload: { context: "log", conditions: ["true"] } },
  },
  { kind: "list", route: `GET ${P}/fleets`, url: `${P}/fleets`, idsOf: itemsIds, foreignIds: (w) => [w.a.fleetId] },
  {
    kind: "creates",
    route: `POST ${P}/fleets`,
    request: () => ({ url: `${P}/fleets`, payload: { label: `b-${randomUUID()}`, type: "server" } }),
    listUrl: `${P}/fleets`,
  },
  {
    kind: "foreign",
    route: `POST ${FLEET}/install`,
    what: "A's fleet",
    request: (w) => ({ url: `${P}/fleets/${w.a.fleetId}/install`, payload: { platform: "docker" } }),
  },
  {
    kind: "foreign",
    route: `POST ${FLEET}/install`,
    what: "A's group on B's fleet",
    request: (w) => ({ url: `${P}/fleets/${w.b.fleetId}/install`, payload: { platform: "docker", groupId: w.a.groupId } }),
  },
  {
    kind: "foreign",
    route: `POST ${FLEET}/install`,
    what: "A's group on B's fleet, linux",
    request: (w) => ({
      url: `${P}/fleets/${w.b.fleetId}/install`,
      payload: { platform: "linux", groupId: w.a.groupId, arch: "amd64", rootPath: "/opt/telflo", systemd: true },
    }),
  },
  {
    kind: "foreign",
    route: `POST ${FLEET}/install`,
    what: "A's group on B's Kubernetes fleet, kubernetes",
    request: (w) => ({ url: `${P}/fleets/${w.b.kubernetesFleetId}/install`, payload: { platform: "kubernetes", groupId: w.a.groupId } }),
  },
  { kind: "foreign", route: `GET ${FLEET}/groups`, what: "A's fleet", request: (w) => ({ url: `${P}/fleets/${w.a.fleetId}/groups` }) },
  {
    kind: "foreign",
    route: `POST ${FLEET}/groups`,
    what: "A's fleet",
    request: (w) => ({ url: `${P}/fleets/${w.a.fleetId}/groups`, payload: { name: "by-b", configurationId: w.a.configurationId, versionNumber: 1 } }),
  },
  {
    kind: "foreign",
    route: `POST ${FLEET}/groups`,
    what: "A's configuration on B's fleet",
    request: (w) => ({ url: `${P}/fleets/${w.b.fleetId}/groups`, payload: { name: "by-b", configurationId: w.a.configurationId, versionNumber: 1 } }),
  },
  {
    kind: "foreign",
    route: `GET ${FLEET}/groups/:groupId`,
    what: "A's fleet and group",
    request: (w) => ({ url: `${P}/fleets/${w.a.fleetId}/groups/${w.a.groupId}` }),
  },
  {
    kind: "foreign",
    route: `GET ${FLEET}/groups/:groupId`,
    what: "A's group on B's fleet",
    request: (w) => ({ url: `${P}/fleets/${w.b.fleetId}/groups/${w.a.groupId}` }),
  },
  {
    kind: "foreign",
    route: `PATCH ${FLEET}/groups/:groupId`,
    what: "A's fleet and group",
    request: (w) => ({ url: `${P}/fleets/${w.a.fleetId}/groups/${w.a.groupId}`, payload: { name: "renamed-by-b" } }),
  },
  {
    kind: "foreign",
    route: `PATCH ${FLEET}/groups/:groupId`,
    what: "A's configuration on B's group",
    request: (w) => ({
      url: `${P}/fleets/${w.b.fleetId}/groups/${w.b.groupId}`,
      payload: { configurationId: w.a.configurationId, versionNumber: 1 },
    }),
  },
  { kind: "none", route: `GET ${P}/flows`, reason: "the published flows are global (decision 45), no organization's" },
  { kind: "none", route: `GET ${P}/flows/:slug`, reason: "the published flows are global (decision 45), no organization's" },
  {
    kind: "foreign",
    route: `POST ${P}/test-runs`,
    what: "A's configuration's version",
    request: (w) => ({
      url: `${P}/test-runs`,
      payload: { configurationId: w.a.configurationId, versionNumber: 1, sample: "{}", signal: "traces", pipeline: "traces", rules: [TEXT_RULE] },
    }),
  },
  { kind: "foreign", route: `GET ${P}/test-runs/:runId`, what: "A's YAML run", request: (w) => ({ url: `${P}/test-runs/${w.a.yamlRunId}` }) },
  { kind: "foreign", route: `GET ${P}/test-runs/:runId`, what: "A's version run", request: (w) => ({ url: `${P}/test-runs/${w.a.versionRunId}` }) },
  {
    kind: "foreign",
    route: `GET ${P}/test-runs/:runId/output`,
    what: "A's YAML run",
    request: (w) => ({ url: `${P}/test-runs/${w.a.yamlRunId}/output` }),
  },
  {
    kind: "foreign",
    route: `GET ${P}/test-runs/:runId/output`,
    what: "A's version run",
    request: (w) => ({ url: `${P}/test-runs/${w.a.versionRunId}/output` }),
  },
];

const methodOf = (route: string) => route.slice(0, route.indexOf(" "));
const patternOf = (route: string) => route.slice(route.indexOf(" ") + 1);

describe("cross-tenant isolation on the public surface (D25 decision 53)", () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let root: string;
  let world: World;
  /** A's resources as A read them before B's calls. */
  let before: Record<string, unknown>;

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  /** A request as `token` (and X-Telflo-Org), its canary first, its reply checked against the document when the route is in it. */
  const call = async (method: string, route: string, request: Request, token: string, organizationId?: string) => {
    const response = await server.inject({
      method: method as "GET",
      url: request.url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(organizationId === undefined ? {} : { "x-telflo-org": organizationId }),
      },
      ...(request.payload === undefined ? {} : { payload: request.payload as object }),
    });
    const holds = [world.a, world.b].some((tenant) => [tenant.read, tenant.write, tenant.personal].some((each) => holdsToken(response.body, each)));
    expect(holds).toBe(false);
    const body: unknown = response.body === "" ? undefined : response.json();
    expect([route, validatePublicReply(method, route, response.statusCode, body).errors]).toEqual([route, []]);
    return response;
  };

  const refusal = (response: LightMyRequestResponse) => ({
    status: response.statusCode,
    code: response.json<{ error?: { code: string } }>().error?.code,
  });

  /** A tenant: an admin person of a new group organization, its service account's tokens, and the person's own write token. */
  const tenant = async (): Promise<Tenant> => {
    const at = new Date(Date.now() - 60_000);
    const admin = await createUserWithOrganization(ownerDb, { user: { email: `person-${randomUUID()}@example.com` } });
    const { organization } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    const { user: account } = await addServiceAccount(ownerDb, { organizationId: organization.id, createdAt: at });
    const tokenOf = async (access: "read" | "write") =>
      (await addApiToken(ownerDb, { organizationId: organization.id, serviceAccountUserId: account.id, created_at: at, access })).token;
    const { token: personal } = await addPersonalApiToken(ownerDb, { userId: admin.user.id, access: "write", created_at: at });
    return { id: organization.id, adminId: admin.user.id, accountUserId: account.id, read: await tokenOf("read"), write: await tokenOf("write"), personal };
  };

  /** A server fleet made through the public API, and its Default group. */
  const fleetOf = async (owner: Tenant, type: "server" | "kubernetes-supervisor" = "server") => {
    const created = await call("POST", `${P}/fleets`, { url: `${P}/fleets`, payload: { label: `edge-${randomUUID()}`, type } }, owner.write);
    expect(created.statusCode).toBe(201);
    const fleetId = created.json<{ id: string }>().id;
    const groups = await call("GET", `${FLEET}/groups`, { url: `${P}/fleets/${fleetId}/groups` }, owner.read);
    return { fleetId, groupId: groups.json<{ items: Array<{ id: string }> }>().items[0]!.id };
  };

  /** A's configuration, its version 1 published in the platform and the fake opamp-server, made by A's account. */
  const publishedConfigurationOf = async (owner: Tenant) => {
    const configuration = await addConfiguration(ownerDb, { organizationId: owner.id, created_by_user_id: owner.accountUserId, name: `a-${randomUUID()}` });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: owner.id,
      created_by_user_id: owner.accountUserId,
      version_number: 1,
      yaml_content: YAML,
      collector_distribution: "otelcol-contrib",
      collector_version: COLLECTOR_VERSION,
      publishedAt: new Date(),
      publishedByUserId: owner.accountUserId,
    });
    const published = await opamp.client.postPublication(owner.id, version.publication_id as string, {
      configuration: { id: configuration.id, name: configuration.name },
      version: { id: version.id, number: 1, label: null },
      yaml: YAML,
      sha256: sha256Hex(YAML),
      publishedBy: null,
      publishedAt: new Date().toISOString(),
      collector: { distribution: "otelcol-contrib", version: COLLECTOR_VERSION },
    });
    expect(published.kind).toBe("created");
    return { configurationId: configuration.id, versionId: version.id };
  };

  /** What A reads of its own resources through its read token. */
  const readA = async () => {
    const reads: Array<[string, string]> = [
      [CONFIGURATION, `${P}/configurations/${world.a.configurationId}`],
      [VERSIONS, `${P}/configurations/${world.a.configurationId}/versions`],
      [VERSION, `${P}/configurations/${world.a.configurationId}/versions/1`],
      [`${VERSION}/validation-pipelines`, `${P}/configurations/${world.a.configurationId}/versions/1/validation-pipelines`],
      [`${P}/configurations`, `${P}/configurations`],
      [`${P}/fleets`, `${P}/fleets`],
      [`${FLEET}/groups`, `${P}/fleets/${world.a.fleetId}/groups`],
      [`${P}/test-runs/:runId`, `${P}/test-runs/${world.a.yamlRunId}`],
      [`${P}/test-runs/:runId`, `${P}/test-runs/${world.a.versionRunId}`],
    ];
    const read: Record<string, unknown> = {};
    for (const [route, url] of reads) {
      const response = await call("GET", route, { url }, world.a.read);
      expect([url, response.statusCode]).toEqual([url, 200]);
      read[url] = response.json();
    }
    return read;
  };

  beforeAll(async () => {
    const settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    root = await mkdtemp(join(tmpdir(), "telflo-public-cross-tenant-"));
    const store = await createFileStore({ kind: "local", root });
    server = buildServer({
      opampServer: opamp.client,
      otelcolValidator: validator.client,
      fileStore: store,
      testing: { ...UNCALLED_TESTING, tester: tester.client, ottlEvaluator: evaluator.client, queued: createTestRunQueueSignal() },
      settings,
      db,
      mailer: createInMemoryMailer(),
      rateLimits: TEST_RATE_LIMITS,
      runAfterResponse: (task) => void task(),
    });
    await server.ready();
    await truncateAll(ownerDb);

    const a = await tenant();
    const b = await tenant();
    // `call` reads the world's tokens for its canary: the tenants first.
    world = {
      a: { ...a, configurationId: "", fleetId: "", groupId: "", yamlRunId: "", versionRunId: "" },
      b: { ...b, fleetId: "", groupId: "", kubernetesFleetId: "" },
    };
    // The fleets first: the fake opamp-server knows an organization from its first fleet.
    const aFleet = await fleetOf(a);
    const bFleet = await fleetOf(b);
    const bKubernetesFleet = await fleetOf(b, "kubernetes-supervisor");
    const configuration = await publishedConfigurationOf(a);
    const yamlRun = await addTestRun(ownerDb, { organizationId: a.id, configurationId: null, configurationVersionId: null, queuedByUserId: a.accountUserId });
    const versionRun = await addTestRun(ownerDb, {
      organizationId: a.id,
      configurationId: configuration.configurationId,
      configurationVersionId: configuration.versionId,
      queuedByUserId: a.accountUserId,
    });
    world = {
      a: { ...a, configurationId: configuration.configurationId, ...aFleet, yamlRunId: yamlRun.id, versionRunId: versionRun.id },
      b: { ...b, ...bFleet, kubernetesFleetId: bKubernetesFleet.fleetId },
    };
    // A's group assigned A's version, so there is something to change.
    const assigned = await call(
      "PATCH",
      `${FLEET}/groups/:groupId`,
      { url: `${P}/fleets/${world.a.fleetId}/groups/${world.a.groupId}`, payload: { configurationId: world.a.configurationId, versionNumber: 1 } },
      a.write,
    );
    expect(assigned.statusCode).toBe(200);
    before = await readA();
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
    await rm(root, { recursive: true, force: true });
  });

  it("covers every public route the server registers (HEAD aside), and names only registered routes", () => {
    const registered = [
      ...new Set(
        publicApiRoutesOf(server)
          .filter((route) => route.method !== "HEAD")
          .map((route) => `${route.method} ${route.url}`),
      ),
    ].sort();
    const covered = [...new Set(ROWS.map((row) => row.route))].sort();
    expect(registered.length).toBeGreaterThan(0);
    expect(covered).toEqual(registered);
  });

  it.each(ROWS.filter((row) => row.kind === "foreign").map((row) => [`${row.route} (${row.what})`, row] as const))(
    "%s: B's callers get the resource's 404, B's person naming A the one 403",
    async (_name, row) => {
      for (const caller of B_CALLERS) {
        const response = await call(methodOf(row.route), patternOf(row.route), row.request(world), caller.token(world), caller.organization?.(world));
        const { status, code } = refusal(response);
        expect([caller.label, status, code !== undefined && /_not_found$/.test(code)]).toEqual([caller.label, 404, true]);
      }
      const naming = await call(
        methodOf(row.route),
        patternOf(row.route),
        row.request(world),
        B_PERSON_NAMING_A.token(world),
        B_PERSON_NAMING_A.organization?.(world),
      );
      expect(refusal(naming)).toEqual({ status: 403, code: "organization_access_denied" });
    },
  );

  it.each(ROWS.filter((row) => row.kind === "list").map((row) => [row.route, row] as const))(
    "%s: B's callers' list holds none of A's ids; B's person naming A gets the one 403",
    async (_name, row) => {
      for (const caller of B_CALLERS) {
        const response = await call("GET", patternOf(row.route), { url: row.url }, caller.token(world), caller.organization?.(world));
        expect([caller.label, response.statusCode]).toEqual([caller.label, 200]);
        const ids = row.idsOf(response.json());
        expect([caller.label, row.foreignIds(world).some((id) => ids.includes(id))]).toEqual([caller.label, false]);
      }
      const naming = await call("GET", patternOf(row.route), { url: row.url }, B_PERSON_NAMING_A.token(world), world.a.id);
      expect(refusal(naming)).toEqual({ status: 403, code: "organization_access_denied" });
    },
  );

  it.each(ROWS.filter((row) => row.kind === "creates").map((row) => [row.route, row] as const))(
    "%s: B's callers' create lands in B, never in A's list; B's person naming A gets the one 403",
    async (_name, row) => {
      for (const caller of B_CALLERS) {
        const created = await call("POST", patternOf(row.route), row.request(), caller.token(world), caller.organization?.(world));
        expect([caller.label, created.statusCode]).toEqual([caller.label, 201]);
        const id = created.json<{ id: string }>().id;
        // The caller's own list (a person's new configuration is a draft, theirs alone: D11b).
        const inB = itemsIds((await call("GET", row.listUrl, { url: row.listUrl }, caller.token(world), caller.organization?.(world))).json());
        const inA = itemsIds((await call("GET", row.listUrl, { url: row.listUrl }, world.a.read)).json());
        expect([caller.label, inB.includes(id), inA.includes(id)]).toEqual([caller.label, true, false]);
      }
      const naming = await call("POST", patternOf(row.route), row.request(), B_PERSON_NAMING_A.token(world), world.a.id);
      expect(refusal(naming)).toEqual({ status: 403, code: "organization_access_denied" });
    },
  );

  it("/whoami names B's organization and /orgs lists B's organizations only, for B's callers", async () => {
    const whoami = ROWS.find((row) => row.kind === "identity" && row.route.endsWith("/whoami"))!;
    const orgs = ROWS.find((row) => row.kind === "identity" && row.route.endsWith("/orgs"))!;
    const account = await call("GET", patternOf(whoami.route), { url: `${P}/whoami` }, world.b.write);
    expect(account.json<{ organizationId?: string }>().organizationId).toBe(world.b.id);
    for (const caller of [{ token: world.b.write }, { token: world.b.personal }]) {
      const listed = await call("GET", patternOf(orgs.route), { url: `${P}/orgs` }, caller.token);
      expect(listed.statusCode).toBe(200);
      const ids = itemsIds(listed.json());
      expect([ids.includes(world.b.id), ids.includes(world.a.id)]).toEqual([true, false]);
    }
    const person = await call("GET", patternOf(whoami.route), { url: `${P}/whoami` }, world.b.personal);
    expect(person.statusCode).toBe(200);
    expect(JSON.stringify(person.json()).includes(world.a.id)).toBe(false);
  });

  it.each(ROWS.flatMap((row) => (row.kind === "none" && row.namingA !== undefined ? [[row.route, row] as const] : [])))(
    "%s: B's person naming A, whose member they aren't, gets the one 403",
    async (_name, row) => {
      const naming = await call(methodOf(row.route), patternOf(row.route), row.namingA!, B_PERSON_NAMING_A.token(world), world.a.id);
      expect(refusal(naming)).toEqual({ status: 403, code: "organization_access_denied" });
    },
  );

  it("lists each route without an organization's id with its reason", () => {
    const none = ROWS.filter((row) => row.kind === "none");
    expect(none.every((row) => row.reason.length > 0)).toBe(true);
    expect(none.map((row) => row.route).sort()).toEqual(
      [
        `GET ${P}/docs`,
        `GET ${P}/docs/*`,
        `GET ${P}/flows`,
        `GET ${P}/flows/:slug`,
        `GET ${P}/health`,
        `GET ${P}/openapi.json`,
        `POST ${P}/ottl/lint`,
        `POST ${P}/validate`,
        `POST ${P}/validate/anonymous`,
      ].sort(),
    );
  });

  // Last: B's calls changed nothing of A's.
  it("leaves A's resources as A read them before B's calls", async () => {
    expect(await readA()).toEqual(before);
    const runs = await ownerDb.selectFrom("test_runs").select(["organization_id"]).execute();
    expect(runs.filter((run) => run.organization_id === world.a.id)).toHaveLength(2);
    expect(runs.filter((run) => run.organization_id !== world.a.id)).toHaveLength(0);
  });
});
