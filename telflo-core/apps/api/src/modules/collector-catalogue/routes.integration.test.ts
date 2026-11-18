import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import { createUserWithOrganization, openTestDatabases, type TestDatabases } from "@telflo/db/testing";
import { prepareTestDatabase, THROWAWAY_DATABASE_DROP_TIMEOUT } from "@telflo/db/test-database";
import { createCollectingRunner } from "../../http/after-response.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { hashPassword } from "../identity/password.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

/** Creating, migrating and dropping a database waits for checkpoints (D7 Ruling 15). */
const THROWAWAY_DATABASE_TIMEOUT = 30_000;

/** The committed catalogue's distribution (D13a decision 1). */
const CONTRIB = "otelcol-contrib";

/** Two Contrib versions this file deprecates, with their notes: fixtures, never the committed catalogue's. */
const RETIRED = "0.150.0";
const RETIRED_NOTE = "Retired fixture: upgrade to the default.";
const ALSO_RETIRED = "0.149.0";

/**
 * A fixture distribution, before Contrib in the catalogue's order and not the
 * default: its versions sort differently by number than as text, one is
 * deprecated, and they support a fixture palette (decision 6).
 */
const FIXTURE = "fixture-build";
const FIXTURE_DEFAULT = "0.10.0";
const FIXTURE_SUPPORTED = {
  receivers: ["otlp"],
  processors: ["batch"],
  exporters: ["debug"],
  connectors: ["forward"],
  extensions: ["health_check"],
};

/** The fixture distribution's renames (D13b decision 6), in an order the test checks is kept. */
const FIXTURE_RENAMES = [
  { kind: "exporter", name: "debug_out", deprecatedName: "debug", since: "0.11.0" },
  { kind: "receiver", name: "otlp_in", deprecatedName: "otlp", since: "0.9.0" },
];

/** A fixture distribution whose only version is deprecated: it offers none. */
const EMPTY = "fixture-empty";

const VERSION_UNKNOWN = { error: { code: "collector_version_unknown", message: "That collector version isn't available." } };
const DISTRIBUTION_UNKNOWN = {
  error: { code: "collector_distribution_unknown", message: "That collector distribution isn't available." },
};

interface OfferBody {
  version: string;
  label: string;
  description: string | null;
  releasedAt: string;
  isDefault: boolean;
  supportedComponents: Record<string, string[]> | null;
}

interface DistributionBody {
  id: string;
  label: string;
  description: string | null;
  icon: string | null;
  isDefault: boolean;
  versions: OfferBody[];
  renamedTypes: Array<{ kind: string; name: string; deprecatedName: string; since: string }>;
}

interface VersionBody {
  id: string;
  versionNumber: number;
  collectorVersion: string;
  collectorVersionDeprecated: boolean;
  collectorVersionDeprecatedNote: string | null;
  yamlContent: string;
}

interface WithVersionBody {
  configuration: { id: string; collectorDistribution: string };
  version: VersionBody;
  versions: Array<Omit<VersionBody, "yamlContent">>;
}

/** `major.minor.patch`, newest first, each part a number. */
function compareVersionsDesc(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const difference = (partsB[index] ?? 0) - (partsA[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/*
 * The catalogue endpoint (D13a decision 11, Ruling 26), and every rule that
 * needs a catalogue the committed one isn't: a deprecated version
 * (decision 4, Preflight rulings 13 and 16), a second distribution
 * (Preflight rulings 14 and 18), a distribution that offers nothing. On a
 * throwaway database the test prepares itself (migrated and synced, as
 * telflo_platform_test is), then adds the fixtures as the tables' owner, since
 * telflo_platform_test's catalogue must stay the committed one. It is dropped
 * afterwards, whatever happens.
 */
describe("the collector catalogue, with fixture distributions and deprecated versions", () => {
  let databases: TestDatabases;
  let throwawayName: string;
  let ownerDb: Kysely<Database>;
  let db: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  /** Contrib's default version as the tables hold it. */
  let contribDefault: string;

  beforeAll(async () => {
    databases = openTestDatabases();
    throwawayName = `telflo_catalogue_routes_${randomUUID().replaceAll("-", "")}_test`;
    const ownerUrl = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerUrl.pathname = `/${throwawayName}`;
    const applicationUrl = new URL(process.env.TELFLO_DATABASE_URL!);
    applicationUrl.pathname = `/${throwawayName}`;
    await prepareTestDatabase(ownerUrl.toString(), applicationUrl.toString());
    ownerDb = createDb(createPool(ownerUrl.toString()));
    db = createDb(createPool(applicationUrl.toString()));

    const version = (
      distribution: string,
      number: string,
      fields: { isDefault?: boolean; deprecatedNote?: string; releasedAt: string; description?: string },
    ) => ({
      distribution,
      version: number,
      label: `v${number}`,
      description: fields.description ?? null,
      released_at: fields.releasedAt,
      is_default: fields.isDefault ?? false,
      deprecated: fields.deprecatedNote !== undefined,
      deprecated_note: fields.deprecatedNote ?? null,
      container_image: `example/${distribution}:${number}`,
      otelcol_contrib_version: distribution === CONTRIB ? null : "0.162.0",
      supported_components: distribution === FIXTURE ? JSON.stringify(FIXTURE_SUPPORTED) : null,
      otelcol_contrib: "{}",
      opamp_supervisor: "{}",
    });
    await ownerDb
      .insertInto("collector_distributions")
      .values([
        {
          id: FIXTURE,
          label: "Fixture Build",
          description: null,
          icon: null,
          sort_order: -1,
          is_default: false,
          renamed_types: JSON.stringify(FIXTURE_RENAMES),
        },
        { id: EMPTY, label: "Fixture Empty", description: "Offers no version.", icon: "otel", sort_order: 9, is_default: false },
      ])
      .execute();
    await ownerDb
      .insertInto("collector_versions")
      .values([
        version(FIXTURE, "0.9.0", { releasedAt: "2026-01-01" }),
        version(FIXTURE, FIXTURE_DEFAULT, { isDefault: true, releasedAt: "2026-02-01", description: "Fixture default." }),
        version(FIXTURE, "0.100.0", { releasedAt: "2026-03-01", deprecatedNote: "Retired fixture build." }),
        version(FIXTURE, "1.2.0", { releasedAt: "2025-06-01" }),
        version(EMPTY, "1.0.0", { releasedAt: "2026-01-01", deprecatedNote: "Nothing left to offer." }),
        version(CONTRIB, RETIRED, { releasedAt: "2026-04-01", deprecatedNote: RETIRED_NOTE }),
        version(CONTRIB, ALSO_RETIRED, { releasedAt: "2026-03-20", deprecatedNote: "Retired fixture too." }),
      ])
      .execute();
    contribDefault = (
      await ownerDb
        .selectFrom("collector_versions")
        .select("version")
        .where("distribution", "=", CONTRIB)
        .where("is_default", "=", true)
        .executeTakeFirstOrThrow()
    ).version;

    server = buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings: loadSettings(process.env),
      db,
      mailer: createInMemoryMailer(),
      now: () => new Date(),
      rateLimits: TEST_RATE_LIMITS,
      runAfterResponse: (task) => createCollectingRunner().run(task),
    });
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
  }, THROWAWAY_DATABASE_TIMEOUT);

  afterAll(async () => {
    await server?.close();
    await db?.destroy();
    await ownerDb?.destroy();
    await sql`drop database if exists ${sql.id(throwawayName)}`.execute(databases.ownerDb);
    await databases.destroy();
  }, THROWAWAY_DATABASE_DROP_TIMEOUT);

  /** A signed-in member of a new personal organization; the access cookie and the organization's id. */
  const signedIn = async (user: { accepted_terms_version?: string } = {}) => {
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `catalogue-${randomUUID()}@example.com`, password_hash: passwordHash, ...user },
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const access = response.cookies.find((cookie) => cookie.name === "telflo_access")!.value;
    return { access, organizationId: account.organization.id };
  };

  const catalogue = (access?: string) =>
    server.inject({
      method: "GET",
      url: "/api/v1/collector-distributions",
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
    });

  const configurations = (organizationId: string) => `/api/v1/organizations/${organizationId}/configurations`;

  const create = (access: string, organizationId: string, payload: Record<string, unknown>) =>
    server.inject({
      method: "POST",
      url: configurations(organizationId),
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload,
    });

  const read = async (access: string, organizationId: string, configurationId: string) => {
    const response = await server.inject({
      method: "GET",
      url: `${configurations(organizationId)}/${configurationId}`,
      cookies: { telflo_access: access },
    });
    expect(response.statusCode).toBe(200);
    return response.json<WithVersionBody>();
  };

  const save = (access: string, organizationId: string, configurationId: string, versionId: string, extra = {}) =>
    server.inject({
      method: "PATCH",
      url: `${configurations(organizationId)}/${configurationId}/versions/${versionId}`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { yamlContent: "receivers: {}\n", nodes: [], edges: [], pipelines: [], ...extra },
    });

  const newVersion = (access: string, organizationId: string, configurationId: string, sourceVersionId: string, extra = {}) =>
    server.inject({
      method: "POST",
      url: `${configurations(organizationId)}/${configurationId}/versions`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { sourceVersionId, yamlContent: "", nodes: [], edges: [], pipelines: [], ...extra },
    });

  /** A configuration created through the API (for `distribution`, else the default) and its version 1. */
  const createdWithVersion = async (access: string, organizationId: string, distribution?: string) => {
    const response = await create(access, organizationId, {
      name: "Gateway",
      ...(distribution === undefined ? {} : { collectorDistribution: distribution }),
    });
    expect(response.statusCode).toBe(201);
    const { configuration } = response.json<{ configuration: { id: string; collectorDistribution: string } }>();
    const { version } = await read(access, organizationId, configuration.id);
    return { configuration, version };
  };

  /** A version's pin moved to `version` as the tables' owner: what a catalogue that later deprecated it leaves. */
  const pinnedTo = (versionId: string, version: string) =>
    ownerDb.updateTable("configuration_versions").set({ collector_version: version }).where("id", "=", versionId).execute();

  const versionRows = (configurationId: string) =>
    ownerDb
      .selectFrom("configuration_versions")
      .select(["version_number", "collector_distribution", "collector_version", "yaml_content", "updated_at"])
      .where("configuration_id", "=", configurationId)
      .orderBy("version_number")
      .execute();

  const expectBody = (response: LightMyRequestResponse, statusCode: number, body: unknown) => {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual(body);
  };

  describe("GET /api/v1/collector-distributions (decision 11, Ruling 26)", () => {
    it("answers every distribution in the catalogue's order, each with the versions it offers, newest first by number, deprecated ones left out, and its renames as stored (D13b decision 6)", async () => {
      const { access } = await signedIn();
      const contribOffered = await ownerDb
        .selectFrom("collector_versions")
        .selectAll()
        .where("distribution", "=", CONTRIB)
        .where("deprecated", "=", false)
        .execute();
      const contrib = await ownerDb
        .selectFrom("collector_distributions")
        .selectAll()
        .where("id", "=", CONTRIB)
        .executeTakeFirstOrThrow();

      const response = await catalogue(access);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        distributions: [
          {
            id: FIXTURE,
            label: "Fixture Build",
            description: null,
            icon: null,
            isDefault: false,
            // 1.2.0 though released first; 0.10.0 before 0.9.0, which text would put after it; 0.100.0 deprecated.
            versions: [
              {
                version: "1.2.0",
                label: "v1.2.0",
                description: null,
                releasedAt: "2025-06-01",
                isDefault: false,
                supportedComponents: FIXTURE_SUPPORTED,
              },
              {
                version: FIXTURE_DEFAULT,
                label: `v${FIXTURE_DEFAULT}`,
                description: "Fixture default.",
                releasedAt: "2026-02-01",
                isDefault: true,
                supportedComponents: FIXTURE_SUPPORTED,
              },
              {
                version: "0.9.0",
                label: "v0.9.0",
                description: null,
                releasedAt: "2026-01-01",
                isDefault: false,
                supportedComponents: FIXTURE_SUPPORTED,
              },
            ],
            renamedTypes: FIXTURE_RENAMES,
          },
          {
            id: CONTRIB,
            label: contrib.label,
            description: contrib.description,
            icon: contrib.icon,
            isDefault: true,
            versions: contribOffered
              .sort((a, b) => compareVersionsDesc(a.version, b.version))
              .map((row) => ({
                version: row.version,
                label: row.label,
                description: row.description,
                releasedAt: row.released_at,
                isDefault: row.is_default,
                supportedComponents: null,
              })),
            renamedTypes: contrib.renamed_types,
          },
          // Inserted without renames: the column's default (migration 1700000000025).
          {
            id: EMPTY,
            label: "Fixture Empty",
            description: "Offers no version.",
            icon: "otel",
            isDefault: false,
            versions: [],
            renamedTypes: [],
          },
        ],
      });
      const body = response.json<{ distributions: DistributionBody[] }>();
      const offeredContrib = body.distributions[1]!.versions.map((offer) => offer.version);
      expect(offeredContrib).not.toContain(RETIRED);
      expect(offeredContrib).not.toContain(ALSO_RETIRED);
      expect(offeredContrib[0]).toBe(contribDefault);
      expect(body.distributions[1]!.versions.filter((offer) => offer.isDefault)).toHaveLength(1);
      // Contrib's are the committed catalogue's, as the sync wrote them.
      expect(body.distributions[1]!.renamedTypes.length).toBeGreaterThan(0);
      expect(body.distributions[1]!.renamedTypes).toContainEqual({
        kind: "receiver",
        name: "file_log",
        deprecatedName: "filelog",
        since: "0.149.0",
      });
    });

    it("answers a signed-out request 401 unauthenticated", async () => {
      expectBody(await catalogue(), 401, { error: { code: "unauthenticated", message: "You need to sign in." } });
    });

    it("answers a member who hasn't accepted the current terms, as /me and /api/v1/organizations do: the catalogue is no one's data", async () => {
      const { access } = await signedIn({ accepted_terms_version: "2025-01-01" });
      expect((await catalogue(access)).statusCode).toBe(200);
    });
  });

  describe("creating a configuration for a distribution (Preflight ruling 14)", () => {
    it("builds it for the distribution named, its version 1 at that distribution's default from the tables, not the catalogue's default", async () => {
      const { access, organizationId } = await signedIn();

      const { configuration, version } = await createdWithVersion(access, organizationId, FIXTURE);

      expect(configuration.collectorDistribution).toBe(FIXTURE);
      expect(version.collectorVersion).toBe(FIXTURE_DEFAULT);
      expect(await versionRows(configuration.id)).toEqual([
        expect.objectContaining({ collector_distribution: FIXTURE, collector_version: FIXTURE_DEFAULT }),
      ]);
    });

    it.each([
      ["one the catalogue doesn't have", "clickstack"],
      ["one that offers no version", EMPTY],
    ])("refuses %s: 400 collector_distribution_unknown, creating nothing", async (_label, collectorDistribution) => {
      const { access, organizationId } = await signedIn();

      expectBody(await create(access, organizationId, { name: "Gateway", collectorDistribution }), 400, DISTRIBUTION_UNKNOWN);
      expect(
        await ownerDb.selectFrom("configurations").select("id").where("organization_id", "=", organizationId).execute(),
      ).toEqual([]);
    });
  });

  describe("a pin the catalogue deprecated since (decision 4, Preflight rulings 13, 15 and 16)", () => {
    it("is read as deprecated, with the catalogue's note, in the version and in its summary", async () => {
      const { access, organizationId } = await signedIn();
      const { configuration, version } = await createdWithVersion(access, organizationId);
      await pinnedTo(version.id, RETIRED);

      const body = await read(access, organizationId, configuration.id);

      const deprecated = {
        collectorVersion: RETIRED,
        collectorVersionDeprecated: true,
        collectorVersionDeprecatedNote: RETIRED_NOTE,
      };
      expect(body.version).toMatchObject(deprecated);
      expect(body.versions).toEqual([expect.objectContaining(deprecated)]);
    });

    it("is kept by a save naming it, which is accepted, and by one leaving it out", async () => {
      const { access, organizationId } = await signedIn();
      const { configuration, version } = await createdWithVersion(access, organizationId);
      await pinnedTo(version.id, RETIRED);

      const named = await save(access, organizationId, configuration.id, version.id, { collectorVersion: RETIRED });
      expect(named.statusCode).toBe(200);
      expect(named.json<{ version: VersionBody }>().version).toMatchObject({
        collectorVersion: RETIRED,
        collectorVersionDeprecated: true,
        collectorVersionDeprecatedNote: RETIRED_NOTE,
      });

      const omitted = await save(access, organizationId, configuration.id, version.id);
      expect(omitted.statusCode).toBe(200);
      expect(omitted.json<{ version: VersionBody }>().version.collectorVersion).toBe(RETIRED);
      expect(await versionRows(configuration.id)).toEqual([expect.objectContaining({ collector_version: RETIRED })]);
    });

    it.each([
      ["a deprecated version", () => RETIRED],
      ["another distribution's version", () => "1.2.0"],
    ])("refuses a change to %s: 400 collector_version_unknown, writing nothing", async (_label, collectorVersion) => {
      const { access, organizationId } = await signedIn();
      const { configuration, version } = await createdWithVersion(access, organizationId);
      const before = await versionRows(configuration.id);

      expectBody(
        await save(access, organizationId, configuration.id, version.id, { collectorVersion: collectorVersion() }),
        400,
        VERSION_UNKNOWN,
      );
      expect(await versionRows(configuration.id)).toEqual(before);
    });

    it("refuses moving a deprecated pin to another deprecated version", async () => {
      const { access, organizationId } = await signedIn();
      const { configuration, version } = await createdWithVersion(access, organizationId);
      await pinnedTo(version.id, RETIRED);

      expectBody(
        await save(access, organizationId, configuration.id, version.id, { collectorVersion: ALSO_RETIRED }),
        400,
        VERSION_UNKNOWN,
      );
      expect(await versionRows(configuration.id)).toEqual([expect.objectContaining({ collector_version: RETIRED })]);
    });

    it("is copied to a new version made from it, with none given or the same given again; another deprecated one is refused", async () => {
      const { access, organizationId } = await signedIn();
      const { configuration, version } = await createdWithVersion(access, organizationId);
      await pinnedTo(version.id, RETIRED);

      const inherited = await newVersion(access, organizationId, configuration.id, version.id);
      expect(inherited.statusCode).toBe(201);
      expect(inherited.json<{ version: VersionBody }>().version).toMatchObject({
        versionNumber: 2,
        collectorVersion: RETIRED,
        collectorVersionDeprecated: true,
        collectorVersionDeprecatedNote: RETIRED_NOTE,
      });

      const restated = await newVersion(access, organizationId, configuration.id, version.id, { collectorVersion: RETIRED });
      expect(restated.statusCode).toBe(201);
      expect(restated.json<{ version: VersionBody }>().version).toMatchObject({ versionNumber: 3, collectorVersion: RETIRED });

      expectBody(
        await newVersion(access, organizationId, configuration.id, version.id, { collectorVersion: ALSO_RETIRED }),
        400,
        VERSION_UNKNOWN,
      );
      expect((await versionRows(configuration.id)).map((row) => row.collector_version)).toEqual([RETIRED, RETIRED, RETIRED]);
    });
  });

  // The distribution a new version is stamped with: the server stamps it,
  // from the configuration it holds locked (Preflight ruling 18).
  describe("a new version's distribution (Preflight ruling 18)", () => {
    it("stamps the new version with the configuration's locked distribution, not the catalogue's default", async () => {
      const { access, organizationId } = await signedIn();
      const { configuration, version } = await createdWithVersion(access, organizationId, FIXTURE);

      const response = await newVersion(access, organizationId, configuration.id, version.id, { collectorVersion: "1.2.0" });

      expect(response.statusCode).toBe(201);
      expect(await versionRows(configuration.id)).toEqual([
        expect.objectContaining({ version_number: 1, collector_distribution: FIXTURE, collector_version: FIXTURE_DEFAULT }),
        expect.objectContaining({ version_number: 2, collector_distribution: FIXTURE, collector_version: "1.2.0" }),
      ]);
    });

    it("checks a new version's pin against the configuration's distribution, never another's (the server always has the configuration)", async () => {
      const { access, organizationId } = await signedIn();
      const { configuration, version } = await createdWithVersion(access, organizationId, FIXTURE);
      const before = await versionRows(configuration.id);

      // Contrib's default: offered, but not by this configuration's distribution.
      expectBody(
        await newVersion(access, organizationId, configuration.id, version.id, { collectorVersion: contribDefault }),
        400,
        VERSION_UNKNOWN,
      );
      expect(await versionRows(configuration.id)).toEqual(before);
    });
  });
});
