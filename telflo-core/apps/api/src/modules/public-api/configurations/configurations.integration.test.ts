import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import {
  addApiToken,
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addServiceAccount,
  catalogueDefaults,
  createUserWithOrganization,
  TEST_CATALOGUE_FIXTURE_NOTE,
  truncateAll,
} from "@telflo/db/testing";
import { createCollectingRunner, type CollectingRunner } from "../../../http/after-response.js";
import { TEST_RATE_LIMITS } from "../../../http/rate-limits.js";
import { createInMemoryMailer } from "../../../mail/in-memory-mailer.js";
import { buildServer } from "../../../server.js";
import { loadSettings, type AppSettings } from "../../../settings.js";
import { UNCALLED_FILE_STORE } from "../../../testing/file-store.js";
import { useFakeOpampServer } from "../../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../../testing/otelcol-testing.js";
import { useFakeOtelcolValidator } from "../../../testing/otelcol-validator.js";
import { validatePublicReply } from "../../../testing/public-api-openapi.js";
import type { OtelcolValidatorClient } from "../../../otelcol-validator/client.js";
import Ajv2020 from "ajv/dist/2020.js";
import {
  PublicCreateConfigurationRequestSchema,
  PublicCreateConfigurationVersionRequestSchema,
  PublicUpdateConfigurationRequestSchema,
  PublicUpdateConfigurationVersionRequestSchema,
} from "@telflo/contracts";
import { publicApiDocument } from "../openapi/document.js";
import { hashPassword } from "../../identity/password.js";
import { apiTokenHash } from "../../service-accounts/tokens.js";

/*
 * The public surface's configurations, versions and publishing, through
 * the real server as the API's own role, with the OpenAPI-checked fakes as
 * the opamp-server and the collector validator.
 * Each route: success through a real service account's token, a read token
 * on a write route 403, another organization's ids 404, another person's
 * draft invisible, and every reply checked against the OpenAPI document.
 *
 * Tokens are built at run time by addApiToken and never printed: `call`
 * runs its canary (a boolean) on every reply before any comparison of it.
 */

const opamp = useFakeOpampServer();
const validator = useFakeOtelcolValidator();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

/** The routes as Fastify registers them, for the reply validator. */
const P = "/api/public/v1";
const ROUTE = {
  list: `${P}/configurations`,
  one: `${P}/configurations/:configurationId`,
  versions: `${P}/configurations/:configurationId/versions`,
  version: `${P}/configurations/:configurationId/versions/:versionNumber`,
  publish: `${P}/configurations/:configurationId/versions/:versionNumber/publish`,
} as const;

type Route = (typeof ROUTE)[keyof typeof ROUTE];

interface CallOptions {
  configurationId?: string;
  versionNumber?: string | number;
  query?: string;
  payload?: unknown;
}

interface ConfigurationBody {
  id: string;
  name: string;
  description: string;
  organizationId: string;
  isPublished: boolean;
  distribution: string;
  collectorVersion: string;
  versionNumber: number;
  publishedVersionNumber: number | null;
  updatedAt: string;
  yaml?: string;
}

interface VersionBody {
  id: string;
  versionNumber: number;
  status: "draft" | "published";
  label: string | null;
  distribution: string;
  collectorVersion: string;
  createdAt: string;
  publishedAt: string | null;
  configurationId?: string;
  yaml?: string;
}

/** A text the fake validator refuses: one error for the unknown component. */
const INVALID_YAML = "receivers:\n  unknown_thing:\nexporters:\n  debug:\nservice:\n  pipelines:\n    traces:\n      receivers: [unknown_thing]\n      exporters: [debug]\n";
const VALID_YAML = "receivers:\n  otlp:\nexporters:\n  debug:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n";

describe("the public configurations routes", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let runner: CollectingRunner;
  let passwordHash: string;
  let logLines: string[] = [];
  let pin: { distribution: string; version: string };
  let otherVersion: string;
  /** A test's hook in front of the validator: it runs, then the fake answers. */
  let beforeValidating: (() => Promise<void>) | undefined;
  const serverValidator: OtelcolValidatorClient = {
    validate: async (request) => {
      await beforeValidating?.();
      return validator.client.validate(request);
    },
  };

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    try {
      server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: serverValidator,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer: createInMemoryMailer(),
        rateLimits: TEST_RATE_LIMITS,
        runAfterResponse: (task) => runner.run(task),
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
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    runner = createCollectingRunner();
    beforeValidating = undefined;
    logLines = [];
    validator.fake.takeRequests();
  });

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  /**
   * An admin person of a new group organization, signed up with a
   * password, and the organization's service account with a read token and
   * a write token, made a minute ago.
   */
  const organization = async () => {
    const at = new Date(Date.now() - 60_000);
    const admin = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash },
    });
    const { organization: group } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    const { user: account } = await addServiceAccount(ownerDb, { organizationId: group.id, createdAt: at });
    const tokenOf = async (access: "read" | "write") =>
      (await addApiToken(ownerDb, { organizationId: group.id, serviceAccountUserId: account.id, created_at: at, access })).token;
    return { id: group.id, admin: admin.user, accountUserId: account.id, read: await tokenOf("read"), write: await tokenOf("write") };
  };

  type Organization = Awaited<ReturnType<typeof organization>>;

  /** A configuration in the organization, made by `createdBy`, with versions as given (number 1 up). */
  const configurationOf = async (
    organizationId: string,
    createdBy: string,
    versions: Array<{ yaml?: string; published?: boolean; collectorVersion?: string; label?: string }> = [{}],
  ) => {
    const configuration = await addConfiguration(ownerDb, { organizationId, created_by_user_id: createdBy });
    const rows = [];
    for (const [index, version] of versions.entries()) {
      rows.push(
        await addConfigurationVersion(ownerDb, {
          configurationId: configuration.id,
          organizationId,
          version_number: index + 1,
          yaml_content: version.yaml ?? VALID_YAML,
          created_by_user_id: createdBy,
          ...(version.label !== undefined && { label: version.label }),
          ...(version.collectorVersion !== undefined && { collector_version: version.collectorVersion }),
          ...(version.published === true && { publishedAt: new Date(), publishedByUserId: createdBy }),
        }),
      );
    }
    return { configuration, versions: rows };
  };

  /**
   * A request to `route` with `token`; the reply's canary first, then the
   * reply checked against the OpenAPI document (its errors name no value).
   */
  const call = async (method: string, route: Route, token: string, options: CallOptions = {}) => {
    const url =
      route.replace(":configurationId", encodeURIComponent(options.configurationId ?? "")).replace(":versionNumber", String(options.versionNumber ?? "")) +
      (options.query ?? "");
    const response = await server.inject({
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

  /** The publications the fake opamp-server holds for the configuration. */
  const publicationsOf = (organizationId: string, configurationId: string) =>
    (opamp.fake.snapshotOf(organizationId).publications as Array<{ configuration: { id: string } }> | undefined ?? []).filter(
      (publication) => publication.configuration.id === configurationId,
    );

  const expectRefusal = (response: LightMyRequestResponse, statusCode: number, code: string) => {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(code);
  };

  const versionRow = (configurationId: string, versionNumber: number) =>
    ownerDb
      .selectFrom("configuration_versions")
      .selectAll()
      .where("configuration_id", "=", configurationId)
      .where("version_number", "=", versionNumber)
      .executeTakeFirstOrThrow();

  const countConfigurations = async (organizationId: string) =>
    Number(
      (
        await ownerDb
          .selectFrom("configurations")
          .select((eb) => eb.fn.countAll().as("count"))
          .where("organization_id", "=", organizationId)
          .executeTakeFirstOrThrow()
      ).count,
    );

  /** Another member of the organization, a contributor, with a draft of their own. */
  const othersDraft = async (organizationId: string) => {
    const other = await createUserWithOrganization(ownerDb);
    await addMembership(ownerDb, { userId: other.user.id, organizationId, role: "contributor" });
    return configurationOf(organizationId, other.user.id);
  };

  describe("GET /configurations", () => {
    it("lists what the token's user sees, with each one's latest number, its pin and its highest published number; not another person's draft nor another organization's", async () => {
      const org = await organization();
      const other = await organization();
      const mixed = await configurationOf(org.id, org.admin.id, [
        { published: true },
        { published: true },
        { collectorVersion: otherVersion },
      ]);
      const own = await configurationOf(org.id, org.accountUserId);
      const hidden = await othersDraft(org.id);
      const elsewhere = await configurationOf(other.id, other.accountUserId, [{ published: true }]);

      const response = await call("GET", ROUTE.list, org.read);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const page = response.json<{ items: ConfigurationBody[]; nextCursor: string | null }>();
      expect(page.nextCursor).toBeNull();
      const ids = page.items.map((item) => item.id);
      expect(ids.sort()).toEqual([mixed.configuration.id, own.configuration.id].sort());
      expect(ids).not.toContain(hidden.configuration.id);
      expect(ids).not.toContain(elsewhere.configuration.id);
      expect(page.items.find((item) => item.id === mixed.configuration.id)).toEqual({
        id: mixed.configuration.id,
        name: mixed.configuration.name,
        description: "",
        organizationId: org.id,
        isPublished: true,
        distribution: pin.distribution,
        collectorVersion: otherVersion,
        versionNumber: 3,
        publishedVersionNumber: 2,
        updatedAt: mixed.configuration.updated_at.toISOString(),
      });
      expect(page.items.find((item) => item.id === own.configuration.id)).toMatchObject({
        isPublished: false,
        versionNumber: 1,
        publishedVersionNumber: null,
        collectorVersion: pin.version,
      });
    });

    it("pages with the browser list's cursor, most recently updated first; a cursor that isn't one is 400", async () => {
      const org = await organization();
      const made = [];
      for (let index = 0; index < 3; index += 1) {
        const { configuration } = await configurationOf(org.id, org.accountUserId);
        await ownerDb
          .updateTable("configurations")
          .set({ updated_at: new Date(Date.UTC(2030, 0, 1 + index)) })
          .where("id", "=", configuration.id)
          .execute();
        made.push(configuration.id);
      }
      const first = await call("GET", ROUTE.list, org.read, { query: "?limit=2" });
      const firstPage = first.json<{ items: ConfigurationBody[]; nextCursor: string | null }>();
      expect(firstPage.items.map((item) => item.id)).toEqual([made[2], made[1]]);
      expect(typeof firstPage.nextCursor).toBe("string");
      const second = await call("GET", ROUTE.list, org.read, {
        query: `?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      });
      const secondPage = second.json<{ items: ConfigurationBody[]; nextCursor: string | null }>();
      expect(secondPage.items.map((item) => item.id)).toEqual([made[0]]);
      expect(secondPage.nextCursor).toBeNull();
      // A cursor that isn't one: the fleets lists' refusal, `{ path, message }`; a schema's `{ path, code }`.
      for (const cursor of ["nonsense", Buffer.from(JSON.stringify({ updatedAt: "2030-01-01", id: "x" })).toString("base64url")]) {
        const badCursor = await call("GET", ROUTE.list, org.read, { query: `?cursor=${cursor}` });
        expectRefusal(badCursor, 400, "invalid_request");
        expect(badCursor.json<{ error: { details: unknown } }>().error.details).toEqual([
          { path: ["cursor"], message: "Not a cursor of this list's: reload the list." },
        ]);
      }
      const overLimit = await call("GET", ROUTE.list, org.read, { query: "?limit=101" });
      expectRefusal(overLimit, 400, "invalid_request");
      expect(overLimit.json<{ error: { details: unknown } }>().error.details).toEqual([{ path: ["limit"], code: "too_big" }]);
      expectRefusal(await call("GET", ROUTE.list, org.read, { query: "?q=x" }), 400, "invalid_request");
    });
  });

  describe("POST /configurations", () => {
    it("creates a draft and its version 1 holding the text as given, with an empty graph, at the default pin; a read token is 403 and makes nothing", async () => {
      const org = await organization();
      const marker = `marker-${randomUUID()}`;
      const yaml = `# ${marker}\n${VALID_YAML}`;
      const refused = await call("POST", ROUTE.list, org.read, { payload: { name: marker, yaml } });
      expectRefusal(refused, 403, "insufficient_access");
      expect(await countConfigurations(org.id)).toBe(0);

      const response = await call("POST", ROUTE.list, org.write, { payload: { name: marker, yaml } });
      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const created = response.json<ConfigurationBody>();
      expect(created).toMatchObject({
        name: marker,
        description: "",
        organizationId: org.id,
        isPublished: false,
        distribution: pin.distribution,
        collectorVersion: pin.version,
        versionNumber: 1,
        publishedVersionNumber: null,
        yaml,
      });
      const row = await versionRow(created.id, 1);
      expect(row).toMatchObject({ yaml_content: yaml, nodes: [], edges: [], pipelines: [], created_by_user_id: org.accountUserId });
      const configuration = await ownerDb.selectFrom("configurations").selectAll().where("id", "=", created.id).executeTakeFirstOrThrow();
      expect(configuration.created_by_user_id).toBe(org.accountUserId);
      // The text and the name are configuration text: in no log line.
      expect(logLines.join("\n").includes(marker)).toBe(false);
    });

    it("answers an unoffered distribution 400 collector_distribution_unknown, and a body over 2 MiB 413; a text at the YAML's limit fits", async () => {
      const org = await organization();
      expectRefusal(
        await call("POST", ROUTE.list, org.write, { payload: { name: "x", yaml: VALID_YAML, distribution: "no-such-build" } }),
        400,
        "collector_distribution_unknown",
      );
      expectRefusal(await call("POST", ROUTE.list, org.write, { payload: { name: "x", yaml: "a".repeat(2 * 1024 * 1024) } }), 413, "payload_too_large");
      expectRefusal(await call("POST", ROUTE.list, org.write, { payload: { name: "x", yaml: VALID_YAML, extra: true } }), 400, "invalid_request");
      expect(await countConfigurations(org.id)).toBe(0);
      // 262,144 × U+0001: six bytes of JSON each, 1.5 MiB in all.
      const largest = await call("POST", ROUTE.list, org.write, { payload: { name: "x", yaml: "\u0001".repeat(262_144) } });
      expect(largest.statusCode).toBe(201);
    });
  });

  describe("GET and PATCH /configurations/{configurationId}", () => {
    it("reads one with its latest version's text; another person's draft, another organization's and a malformed id are 404", async () => {
      const org = await organization();
      const other = await organization();
      const { configuration } = await configurationOf(org.id, org.accountUserId, [{ yaml: "first: 1\n" }, { yaml: "second: 2\n" }]);
      const response = await call("GET", ROUTE.one, org.read, { configurationId: configuration.id });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<ConfigurationBody>()).toMatchObject({ id: configuration.id, versionNumber: 2, yaml: "second: 2\n" });

      const hidden = await othersDraft(org.id);
      const elsewhere = await configurationOf(other.id, other.accountUserId, [{ published: true }]);
      for (const id of [hidden.configuration.id, elsewhere.configuration.id, "not-a-uuid", randomUUID()]) {
        expectRefusal(await call("GET", ROUTE.one, org.read, { configurationId: id }), 404, "configuration_not_found");
      }
    });

    it("changes the name and the description (null clears it); a read token is 403; another's draft and another organization's are 404", async () => {
      const org = await organization();
      const other = await organization();
      const { configuration } = await configurationOf(org.id, org.accountUserId);
      expectRefusal(
        await call("PATCH", ROUTE.one, org.read, { configurationId: configuration.id, payload: { name: "renamed" } }),
        403,
        "insufficient_access",
      );
      const renamed = await call("PATCH", ROUTE.one, org.write, {
        configurationId: configuration.id,
        payload: { name: "  renamed  ", description: "described" },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json<ConfigurationBody>()).toMatchObject({ name: "renamed", description: "described", versionNumber: 1 });
      const cleared = await call("PATCH", ROUTE.one, org.write, { configurationId: configuration.id, payload: { description: null } });
      expect(cleared.json<ConfigurationBody>()).toMatchObject({ name: "renamed", description: "" });
      expectRefusal(
        await call("PATCH", ROUTE.one, org.write, { configurationId: configuration.id, payload: { description: "d".repeat(501) } }),
        400,
        "invalid_request",
      );

      const hidden = await othersDraft(org.id);
      const elsewhere = await configurationOf(other.id, other.accountUserId, [{ published: true }]);
      for (const id of [hidden.configuration.id, elsewhere.configuration.id, "not-a-uuid"]) {
        expectRefusal(await call("PATCH", ROUTE.one, org.write, { configurationId: id, payload: { name: "taken" } }), 404, "configuration_not_found");
      }
      expect((await ownerDb.selectFrom("configurations").select("name").where("id", "=", hidden.configuration.id).executeTakeFirstOrThrow()).name).not.toBe(
        "taken",
      );
    });
  });

  describe("GET and POST /configurations/{configurationId}/versions", () => {
    it("lists every version, highest first, in one page; another's draft and another organization's are 404", async () => {
      const org = await organization();
      const other = await organization();
      const { configuration, versions } = await configurationOf(org.id, org.admin.id, [{ published: true, label: "first" }, {}]);
      const response = await call("GET", ROUTE.versions, org.read, { configurationId: configuration.id });
      expect(response.statusCode).toBe(200);
      const list = response.json<{ items: VersionBody[]; nextCursor: null }>();
      expect(list.nextCursor).toBeNull();
      expect(list.items).toEqual([
        {
          id: versions[1]!.id,
          versionNumber: 2,
          status: "draft",
          label: null,
          distribution: pin.distribution,
          collectorVersion: pin.version,
          createdAt: versions[1]!.created_at.toISOString(),
          publishedAt: null,
        },
        expect.objectContaining({ id: versions[0]!.id, versionNumber: 1, status: "published", label: "first" }),
      ]);
      const hidden = await othersDraft(org.id);
      const elsewhere = await configurationOf(other.id, other.accountUserId, [{ published: true }]);
      for (const id of [hidden.configuration.id, elsewhere.configuration.id, "not-a-uuid"]) {
        expectRefusal(await call("GET", ROUTE.versions, org.read, { configurationId: id }), 404, "configuration_not_found");
      }
    });

    it("appends the next version from the latest (its pin), holding the text as given with an empty graph; a read token is 403; another's draft and another organization's are 404", async () => {
      const org = await organization();
      const other = await organization();
      const { configuration } = await configurationOf(org.id, org.admin.id, [{ published: true }, { collectorVersion: otherVersion }]);
      expectRefusal(
        await call("POST", ROUTE.versions, org.read, { configurationId: configuration.id, payload: { yaml: VALID_YAML } }),
        403,
        "insufficient_access",
      );
      const response = await call("POST", ROUTE.versions, org.write, {
        configurationId: configuration.id,
        payload: { yaml: "appended: true\n", label: " third " },
      });
      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<VersionBody>()).toMatchObject({
        configurationId: configuration.id,
        versionNumber: 3,
        status: "draft",
        label: "third",
        collectorVersion: otherVersion,
        yaml: "appended: true\n",
      });
      expect(await versionRow(configuration.id, 3)).toMatchObject({ nodes: [], edges: [], created_by_user_id: org.accountUserId });
      const unnamed = await call("POST", ROUTE.versions, org.write, { configurationId: configuration.id, payload: { yaml: "", label: null } });
      expect(unnamed.json<VersionBody>()).toMatchObject({ versionNumber: 4, label: null });
      for (const label of ["", " ", "l".repeat(81)]) {
        expectRefusal(
          await call("POST", ROUTE.versions, org.write, { configurationId: configuration.id, payload: { yaml: "", label } }),
          400,
          "invalid_request",
        );
      }

      const hidden = await othersDraft(org.id);
      const elsewhere = await configurationOf(other.id, other.accountUserId, [{ published: true }]);
      for (const id of [hidden.configuration.id, elsewhere.configuration.id, "not-a-uuid"]) {
        expectRefusal(await call("POST", ROUTE.versions, org.write, { configurationId: id, payload: { yaml: "" } }), 404, "configuration_not_found");
      }
      const counts = await ownerDb
        .selectFrom("configuration_versions")
        .select("configuration_id")
        .where("configuration_id", "in", [hidden.configuration.id, elsewhere.configuration.id])
        .execute();
      expect(counts).toHaveLength(2);
    });
  });

  describe("GET /configurations/{configurationId}/versions/{versionNumber}", () => {
    it("reads a version by its number; a number that isn't plain is 400; one it hasn't is 404 configuration_version_not_found", async () => {
      const org = await organization();
      const other = await organization();
      const { configuration, versions } = await configurationOf(org.id, org.accountUserId, [{ yaml: "one: 1\n" }, { yaml: "two: 2\n" }]);
      const response = await call("GET", ROUTE.version, org.read, { configurationId: configuration.id, versionNumber: 1 });
      expect(response.statusCode).toBe(200);
      expect(response.json<VersionBody>()).toMatchObject({
        id: versions[0]!.id,
        configurationId: configuration.id,
        versionNumber: 1,
        status: "draft",
        yaml: "one: 1\n",
      });
      for (const versionNumber of ["07", "1e2", "0", "-1", "1.0", "1234567890"]) {
        expectRefusal(await call("GET", ROUTE.version, org.read, { configurationId: configuration.id, versionNumber }), 400, "invalid_request");
      }
      expectRefusal(
        await call("GET", ROUTE.version, org.read, { configurationId: configuration.id, versionNumber: 3 }),
        404,
        "configuration_version_not_found",
      );
      const hidden = await othersDraft(org.id);
      const elsewhere = await configurationOf(other.id, other.accountUserId, [{ published: true }]);
      for (const id of [hidden.configuration.id, elsewhere.configuration.id, "not-a-uuid"]) {
        expectRefusal(await call("GET", ROUTE.version, org.read, { configurationId: id, versionNumber: 1 }), 404, "configuration_not_found");
      }
    });
  });

  describe("PATCH /configurations/{configurationId}/versions/{versionNumber}", () => {
    it("merges the text and the pin over a draft, keeping the stored graph; neither changes nothing; a read token is 403", async () => {
      const org = await organization();
      const { configuration } = await configurationOf(org.id, org.accountUserId, [{ yaml: "stored: 1\n" }]);
      const graph = [{ id: "node_0", kept: true }];
      await ownerDb
        .updateTable("configuration_versions")
        .set({ nodes: JSON.stringify(graph) as never })
        .where("configuration_id", "=", configuration.id)
        .execute();
      const target = { configurationId: configuration.id, versionNumber: 1 };
      expectRefusal(await call("PATCH", ROUTE.version, org.read, { ...target, payload: { yaml: "x: 1\n" } }), 403, "insufficient_access");

      const textOnly = await call("PATCH", ROUTE.version, org.write, { ...target, payload: { yaml: "patched: 1\n" } });
      expect(textOnly.statusCode).toBe(200);
      expect(textOnly.json<VersionBody>()).toMatchObject({ yaml: "patched: 1\n", collectorVersion: pin.version, status: "draft" });
      expect(await versionRow(configuration.id, 1)).toMatchObject({ yaml_content: "patched: 1\n", nodes: graph });

      const pinOnly = await call("PATCH", ROUTE.version, org.write, { ...target, payload: { collectorVersion: otherVersion } });
      expect(pinOnly.json<VersionBody>()).toMatchObject({ yaml: "patched: 1\n", collectorVersion: otherVersion });
      expect(await versionRow(configuration.id, 1)).toMatchObject({ collector_version: otherVersion, nodes: graph });

      const before = await versionRow(configuration.id, 1);
      const nothing = await call("PATCH", ROUTE.version, org.write, { ...target, payload: {} });
      expect(nothing.statusCode).toBe(200);
      expect((await versionRow(configuration.id, 1)).updated_at).toEqual(before.updated_at);
      const audits = await ownerDb
        .selectFrom("audit_events")
        .select("action")
        .where("subject_id", "=", configuration.id)
        .where("action", "=", "configuration.version_saved")
        .execute();
      expect(audits).toHaveLength(2);

      expectRefusal(
        await call("PATCH", ROUTE.version, org.write, { ...target, payload: { collectorVersion: "999.0.0" } }),
        400,
        "collector_version_unknown",
      );
      expectRefusal(await call("PATCH", ROUTE.version, org.write, { ...target, payload: { yaml: null } }), 400, "invalid_request");
      expectRefusal(await call("PATCH", ROUTE.version, org.write, { ...target, payload: { distribution: "x" } }), 400, "invalid_request");
      expect(validator.fake.takeRequests()).toEqual([]);
    });

    it("refuses a published version 409 configuration_version_published, with ?validate=true before asking the validator; another's draft and another organization's are 404", async () => {
      const org = await organization();
      const other = await organization();
      const { configuration } = await configurationOf(org.id, org.admin.id, [{ published: true, yaml: "published: 1\n" }]);
      const target = { configurationId: configuration.id, versionNumber: 1 };
      for (const query of ["", "?validate=true"]) {
        expectRefusal(
          await call("PATCH", ROUTE.version, org.write, { ...target, query, payload: { yaml: VALID_YAML } }),
          409,
          "configuration_version_published",
        );
      }
      expect(validator.fake.takeRequests()).toEqual([]);
      expect((await versionRow(configuration.id, 1)).yaml_content).toBe("published: 1\n");

      const hidden = await othersDraft(org.id);
      const elsewhere = await configurationOf(other.id, other.accountUserId);
      for (const id of [hidden.configuration.id, elsewhere.configuration.id, "not-a-uuid"]) {
        expectRefusal(
          await call("PATCH", ROUTE.version, org.write, { configurationId: id, versionNumber: 1, payload: { yaml: "taken: 1\n" } }),
          404,
          "configuration_not_found",
        );
      }
      expect((await versionRow(hidden.configuration.id, 1)).yaml_content).toBe(VALID_YAML);
      expect((await versionRow(elsewhere.configuration.id, 1)).yaml_content).toBe(VALID_YAML);
    });

    it("with ?validate=true validates the merged text first: invalid is 422 configuration_invalid with the errors, saving nothing; valid is saved", async () => {
      const org = await organization();
      const { configuration } = await configurationOf(org.id, org.accountUserId, [{ yaml: "stored: 1\n" }]);
      const target = { configurationId: configuration.id, versionNumber: 1 };

      const refused = await call("PATCH", ROUTE.version, org.write, { ...target, query: "?validate=true", payload: { yaml: INVALID_YAML } });
      expect(refused.statusCode).toBe(422);
      expect(refused.headers["cache-control"]).toBe("no-store");
      const error = refused.json<{ error: { code: string; message: string; details: { errors: Array<{ message: string; componentPath: string | null }> } } }>().error;
      expect(error.code).toBe("configuration_invalid");
      expect(error.message).toBe("The configuration is not valid.");
      expect(error.details.errors.length).toBeGreaterThan(0);
      expect(error.details.errors.some((item) => item.componentPath?.includes("unknown_thing") === true)).toBe(true);
      expect((await versionRow(configuration.id, 1)).yaml_content).toBe("stored: 1\n");
      const asked = validator.fake.takeRequests();
      expect(asked.map(({ distribution, version, yaml }) => ({ distribution, version, yaml }))).toEqual([
        { distribution: pin.distribution, version: pin.version, yaml: INVALID_YAML },
      ]);

      // No text sent: the stored one, merged, is what is validated.
      await call("PATCH", ROUTE.version, org.write, { ...target, query: "?validate=false", payload: { yaml: INVALID_YAML } });
      expect(validator.fake.takeRequests()).toEqual([]);
      expectRefusal(await call("PATCH", ROUTE.version, org.write, { ...target, query: "?validate=true", payload: {} }), 422, "configuration_invalid");
      expect(validator.fake.takeRequests().map(({ yaml }) => yaml)).toEqual([INVALID_YAML]);

      const saved = await call("PATCH", ROUTE.version, org.write, {
        ...target,
        query: "?validate=true",
        payload: { yaml: VALID_YAML, collectorVersion: otherVersion },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json<VersionBody>()).toMatchObject({ yaml: VALID_YAML, collectorVersion: otherVersion });
      expect(validator.fake.takeRequests().map(({ version, yaml }) => ({ version, yaml }))).toEqual([{ version: otherVersion, yaml: VALID_YAML }]);
      expectRefusal(await call("PATCH", ROUTE.version, org.write, { ...target, query: "?validate=yes", payload: {} }), 400, "invalid_request");
    });

    it("with ?validate=true saves only the text it validated: a save landing in between is 409 configuration_version_changed, saving nothing", async () => {
      const org = await organization();
      const { configuration } = await configurationOf(org.id, org.accountUserId, [{ yaml: "stored: 1\n" }]);
      const target = { configurationId: configuration.id, versionNumber: 1 };
      const CHANGED_WHILE_VALIDATING = "This version changed while it was being validated. Nothing was saved. Try again.";
      /** While the validator is asked, once, another save of the version lands, through the service. */
      const saveWhileValidating = (payload: object) => {
        beforeValidating = async () => {
          beforeValidating = undefined;
          expect((await call("PATCH", ROUTE.version, org.write, { ...target, payload })).statusCode).toBe(200);
        };
      };

      // A text sent: the one validated isn't written over the save that landed.
      saveWhileValidating({ yaml: "between: 1\n" });
      const textSent = await call("PATCH", ROUTE.version, org.write, { ...target, query: "?validate=true", payload: { yaml: VALID_YAML } });
      expectRefusal(
        textSent,
        409,
        "configuration_version_changed",
      );
      expect(textSent.json<{ error: { message: string } }>().error.message).toBe(CHANGED_WHILE_VALIDATING);
      expect((await versionRow(configuration.id, 1)).yaml_content).toBe("between: 1\n");

      // No text sent: the stored text validated, then a save changes the pin; nothing is written over it.
      await call("PATCH", ROUTE.version, org.write, { ...target, payload: { yaml: VALID_YAML } });
      saveWhileValidating({ collectorVersion: otherVersion });
      const noText = await call("PATCH", ROUTE.version, org.write, { ...target, query: "?validate=true", payload: {} });
      expectRefusal(
        noText,
        409,
        "configuration_version_changed",
      );
      expect(noText.json<{ error: { message: string } }>().error.message).toBe(CHANGED_WHILE_VALIDATING);
      expect(await versionRow(configuration.id, 1)).toMatchObject({ yaml_content: VALID_YAML, collector_version: otherVersion });
      expect(validator.fake.takeRequests()).toHaveLength(2);
      // With nothing landing in between, the validated text is saved.
      const saved = await call("PATCH", ROUTE.version, org.write, { ...target, query: "?validate=true", payload: { yaml: `${VALID_YAML}# again\n` } });
      expect(saved.statusCode).toBe(200);
      expect((await versionRow(configuration.id, 1)).yaml_content).toBe(`${VALID_YAML}# again\n`);
    });

    it("with ?validate=true answers a retired pin 400 collector_version_retired, saving nothing, without asking the validator", async () => {
      const org = await organization();
      const { configuration } = await configurationOf(org.id, org.accountUserId, [{ yaml: "stored: 1\n" }]);
      const retired = `0.0.${Math.floor(Math.random() * 1_000_000)}`;
      const template = await ownerDb
        .selectFrom("collector_versions")
        .selectAll()
        .where("distribution", "=", pin.distribution)
        .where("version", "=", pin.version)
        .executeTakeFirstOrThrow();
      await ownerDb
        .insertInto("collector_versions")
        .values({
          ...template,
          version: retired,
          label: `v${retired}`,
          is_default: false,
          deprecated: true,
          deprecated_note: "Retired fixture.",
          // The test-only mark: a killed run's row is removed before the next run's catalog sync.
          description: TEST_CATALOGUE_FIXTURE_NOTE,
          // The JSON columns as text, as the catalog's sync writes them.
          supported_components: template.supported_components === null ? null : (JSON.stringify(template.supported_components) as never),
          otelcol_contrib: JSON.stringify(template.otelcol_contrib) as never,
          opamp_supervisor: JSON.stringify(template.opamp_supervisor) as never,
        })
        .execute();
      try {
        const target = { configurationId: configuration.id, versionNumber: 1 };
        expectRefusal(
          await call("PATCH", ROUTE.version, org.write, { ...target, query: "?validate=true", payload: { yaml: VALID_YAML, collectorVersion: retired } }),
          400,
          "collector_version_retired",
        );
        // Without validation the save's own rule answers it: a pin the distribution doesn't offer.
        expectRefusal(
          await call("PATCH", ROUTE.version, org.write, { ...target, payload: { collectorVersion: retired } }),
          400,
          "collector_version_unknown",
        );
        expect(validator.fake.takeRequests()).toEqual([]);
        expect(await versionRow(configuration.id, 1)).toMatchObject({ yaml_content: "stored: 1\n", collector_version: pin.version });
      } finally {
        await ownerDb.deleteFrom("collector_versions").where("distribution", "=", pin.distribution).where("version", "=", retired).execute();
      }
    });
  });

  describe("POST /configurations/{configurationId}/versions/{versionNumber}/publish", () => {
    it("publishes through the publishing service to the opamp-server, and again answers 200 unchanged with no second publication; a read token is 403", async () => {
      const org = await organization();
      const { configuration, versions } = await configurationOf(org.id, org.accountUserId, [{ published: false }, { yaml: "second: 2\n" }]);
      const target = { configurationId: configuration.id, versionNumber: 1 };
      expectRefusal(await call("POST", ROUTE.publish, org.read, target), 403, "insufficient_access");
      expect(publicationsOf(org.id, configuration.id)).toHaveLength(0);

      const response = await call("POST", ROUTE.publish, org.write, target);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<ConfigurationBody>()).toMatchObject({
        id: configuration.id,
        isPublished: true,
        versionNumber: 2,
        publishedVersionNumber: 1,
        yaml: "second: 2\n",
      });
      const published = await versionRow(configuration.id, 1);
      expect(published.published_at).not.toBeNull();
      expect(published.published_by_user_id).toBe(org.accountUserId);
      expect(publicationsOf(org.id, configuration.id)).toHaveLength(1);

      const again = await call("POST", ROUTE.publish, org.write, target);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(response.json());
      expect((await versionRow(configuration.id, 1)).published_at).toEqual(published.published_at);
      expect(publicationsOf(org.id, configuration.id)).toHaveLength(1);
      expect(versions[0]!.id).toBe(published.id);
      await runner.settle();
    });

    it("answers two publishes at once 200 each, with one record", async () => {
      const org = await organization();
      const { configuration } = await configurationOf(org.id, org.accountUserId);
      const target = { configurationId: configuration.id, versionNumber: 1 };
      const [first, second] = await Promise.all([call("POST", ROUTE.publish, org.write, target), call("POST", ROUTE.publish, org.write, target)]);
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(first.json<ConfigurationBody>()).toMatchObject({ isPublished: true, publishedVersionNumber: 1 });
      expect(second.json<ConfigurationBody>()).toMatchObject({ isPublished: true, publishedVersionNumber: 1 });
      await runner.settle();
      expect(publicationsOf(org.id, configuration.id)).toHaveLength(1);
    });

    it("keeps 409 configuration_version_empty for an empty text; another's draft, another organization's and an unknown number are 404", async () => {
      const org = await organization();
      const other = await organization();
      const { configuration } = await configurationOf(org.id, org.accountUserId, [{ yaml: "" }]);
      expectRefusal(
        await call("POST", ROUTE.publish, org.write, { configurationId: configuration.id, versionNumber: 1 }),
        409,
        "configuration_version_empty",
      );
      expectRefusal(
        await call("POST", ROUTE.publish, org.write, { configurationId: configuration.id, versionNumber: 2 }),
        404,
        "configuration_version_not_found",
      );
      expectRefusal(
        await call("POST", ROUTE.publish, org.write, { configurationId: configuration.id, versionNumber: "01" }),
        400,
        "invalid_request",
      );
      const hidden = await othersDraft(org.id);
      const elsewhere = await configurationOf(other.id, other.accountUserId);
      for (const id of [hidden.configuration.id, elsewhere.configuration.id, "not-a-uuid"]) {
        expectRefusal(await call("POST", ROUTE.publish, org.write, { configurationId: id, versionNumber: 1 }), 404, "configuration_not_found");
      }
      expect(publicationsOf(other.id, elsewhere.configuration.id)).toHaveLength(0);
      expect((await versionRow(hidden.configuration.id, 1)).published_at).toBeNull();
    });
  });

  describe("body limits", () => {
    it("answers 413 payload_too_large past 2 MiB on the append and the version PATCH, past 1 MiB on the configuration PATCH and the publish, writing nothing", async () => {
      const org = await organization();
      const { configuration } = await configurationOf(org.id, org.accountUserId, [{ yaml: "stored: 1\n" }]);
      const over2MiB = "a".repeat(2 * 1024 * 1024);
      const over1MiB = "a".repeat(1024 * 1024);
      const target = { configurationId: configuration.id, versionNumber: 1 };
      expectRefusal(await call("POST", ROUTE.versions, org.write, { configurationId: configuration.id, payload: { yaml: over2MiB } }), 413, "payload_too_large");
      expectRefusal(await call("PATCH", ROUTE.version, org.write, { ...target, payload: { yaml: over2MiB } }), 413, "payload_too_large");
      expectRefusal(
        await call("PATCH", ROUTE.one, org.write, { configurationId: configuration.id, payload: { description: over1MiB } }),
        413,
        "payload_too_large",
      );
      expectRefusal(await call("POST", ROUTE.publish, org.write, { ...target, payload: { padding: over1MiB } }), 413, "payload_too_large");
      // Under the version writes' 2 MiB, past the server's 1 MiB: their own limit applies.
      const between = await call("PATCH", ROUTE.version, org.write, { ...target, payload: { yaml: "\u0001".repeat(262_144) } });
      expect(between.statusCode).toBe(200);
      expect(await ownerDb.selectFrom("configuration_versions").select("version_number").where("configuration_id", "=", configuration.id).execute()).toHaveLength(1);
      expect((await versionRow(configuration.id, 1)).published_at).toBeNull();
      expect(publicationsOf(org.id, configuration.id)).toHaveLength(0);
    });
  });

  describe("the OpenAPI document's requests are the contracts'", () => {
    /** Each request schema of the document, compiled as the reply validator compiles a reply's. */
    const compiled = (name: string) => {
      const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
      const schemas = publicApiDocument().components.schemas ?? {};
      const rewritten = JSON.parse(JSON.stringify(schemas).replaceAll("#/components/schemas/", "#/$defs/")) as Record<string, object>;
      return ajv.compile({ $defs: rewritten, $ref: `#/$defs/${name}` });
    };
    const cases: Array<{ name: string; contract: { safeParse: (value: unknown) => { success: boolean } }; bodies: unknown[] }> = [
      {
        name: "CreateConfigurationRequest",
        contract: PublicCreateConfigurationRequestSchema,
        bodies: [
          { name: "G", yaml: "" },
          { name: "G", yaml: "a: 1\n", distribution: "otelcol-contrib" },
          { name: "", yaml: "" },
          { name: " ", yaml: "" },
          { name: "n".repeat(201), yaml: "" },
          { name: "G" },
          { name: "G", yaml: "\u0000" },
          { name: "G\u0000", yaml: "" },
          { name: "G\uDC00", yaml: "" },
          { name: "G🚀", yaml: "a🚀b" },
          { name: "G", yaml: "a\uD800b" },
          { name: "G", yaml: "a".repeat(262_145) },
          { name: "G", yaml: "", distribution: "Not A Distribution" },
          { name: "G", yaml: "", distribution: "d".repeat(65) },
          { name: "G", yaml: "", description: "d" },
        ],
      },
      {
        name: "UpdateConfigurationRequest",
        contract: PublicUpdateConfigurationRequestSchema,
        bodies: [{}, { name: "N", description: null }, { description: "d" }, { name: "" }, { name: null }, { description: "d".repeat(501) }, { description: "\u0000" }, { description: "a\uD800b" }, { name: "G\uDC00" }, { yaml: "" }],
      },
      {
        name: "CreateConfigurationVersionRequest",
        contract: PublicCreateConfigurationVersionRequestSchema,
        bodies: [{ yaml: "" }, { yaml: "", label: null }, { yaml: "", label: "v2" }, { yaml: "", label: "" }, { yaml: "", label: "  " }, { yaml: "", label: "l".repeat(81) }, { label: "x" }, { yaml: "\u0000" }, { yaml: "a\uD800b" }, { yaml: "", label: "G\uDC00" }],
      },
      {
        name: "UpdateConfigurationVersionRequest",
        contract: PublicUpdateConfigurationVersionRequestSchema,
        bodies: [{}, { yaml: "a: 1\n", collectorVersion: "0.162.0" }, { yaml: null }, { collectorVersion: "latest" }, { collectorVersion: `1.2.${"3".repeat(70)}` }, { yaml: "\u0000" }, { yaml: "a\uD800b" }, { distribution: "x" }],
      },
    ];

    it.each(cases)("$name accepts and refuses each body as its contract does", ({ name, contract, bodies }) => {
      const validate = compiled(name);
      const disagreements = bodies.flatMap((body, index) => (validate(body) === contract.safeParse(body).success ? [] : [index]));
      expect(disagreements).toEqual([]);
    });
  });

  describe("drafts stay private both ways", () => {
    /** The organization's admin, signed in to the browser and active in it. */
    const signedInAdmin = async (org: Organization) => {
      const signIn = await server.inject({
        method: "POST",
        url: "/api/v1/auth/sessions",
        headers: csrfHeaders,
        payload: { email: org.admin.email, password: PASSWORD },
      });
      expect(signIn.statusCode).toBe(200);
      const switched = await server.inject({
        method: "PUT",
        url: "/api/v1/auth/sessions/current/organization",
        headers: csrfHeaders,
        cookies: { telflo_access: cookieValue(signIn, "telflo_access") },
        payload: { organizationId: org.id },
      });
      expect(switched.statusCode).toBe(200);
      // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
      return switched.headers["set-cookie"] === undefined ? cookieValue(signIn, "telflo_access") : cookieValue(switched, "telflo_access");
    };

    it("the account's own draft, made through the public API, is invisible to a person in the browser API, even an admin", async () => {
      const org = await organization();
      const created = await call("POST", ROUTE.list, org.write, { payload: { name: "account's draft", yaml: VALID_YAML } });
      const id = created.json<ConfigurationBody>().id;
      const access = await signedInAdmin(org);
      const list = await server.inject({
        method: "GET",
        url: `/api/v1/organizations/${org.id}/configurations`,
        cookies: { telflo_access: access },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)).not.toContain(id);
      const read = await server.inject({
        method: "GET",
        url: `/api/v1/organizations/${org.id}/configurations/${id}`,
        cookies: { telflo_access: access },
      });
      expect(read.statusCode).toBe(404);
      // Published, it is everyone's.
      await call("POST", ROUTE.publish, org.write, { configurationId: id, versionNumber: 1 });
      const after = await server.inject({
        method: "GET",
        url: `/api/v1/organizations/${org.id}/configurations/${id}`,
        cookies: { telflo_access: access },
      });
      expect(after.statusCode).toBe(200);
      await runner.settle();
    });
  });
});

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`the response set no ${name} cookie`);
  return line.slice(name.length + 1, line.indexOf(";"));
}
