import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Insertable, type Kysely } from "kysely";
import pg from "pg";
import { migrateToLatest } from "./migrations.js";
import { createDb, createPool } from "./pool.js";
import type { Database, FlowsTable } from "./schema.js";
import { THROWAWAY_DATABASE_DROP_TIMEOUT } from "./test-database.js";
import {
  addConfiguration,
  catalogueDefaults,
  createUserWithOrganization,
  insertSeededFlows,
  loadFlowsMigration,
  openTestDatabases,
  truncateAll,
  type FlowsMigration,
  type SeededFlow,
  type TestDatabases,
} from "./testing.js";

/*
 * Migration 1700000000026: the flows table and its checks, the 13 seeded
 * flows, the product-admin flag and its owner-only trigger, and
 * configurations.source_flow_slug. Its up, down and up again are
 * schema.integration.test.ts's ("the flows migration …"), as are those of
 * migration 1700000000027, the signals' check, whose refusals are here.
 *
 * The seeded flows are checked on a throwaway database migrated to the latest
 * migration: truncateAll empties them from telflo_platform_test before every
 * test.
 */

/** Creating and dropping a database waits for a checkpoint. */
const THROWAWAY_DATABASE_TIMEOUT = 30_000;

/**
 * The 13 seeded flows as Postgres stores them, by slug: each text's SHA-256
 * (of its UTF-8) and its length in characters, derived in a throwaway Postgres
 * 18, and the pin. Every flow is otelcol-contrib, telflo, published, with no
 * author URL.
 */
const expectedSeededFlows = [
  {
    slug: "log-volume-cost-control",
    name: "Log Volume Cost Control",
    sortOrder: 10,
    telfloAppPin: "0.147.0",
    version: "0.162.0",
    yaml: { sha256: "1f3d7ca76e09e9af54dd923a43331d84f4363585c524a3db1355dc081849e10b", length: 3326 },
    summarySha256: "91795d2646f46e0402e20495f77a0aff5701f0bd1f4d597e2e7ef30ed81e4a0b",
    descriptionSha256: "a1096ceb229a648d303597e5f6668b8dad5551571993ae19f9ec6c36de779a0f",
    signals: ["logs"],
    tags: ["cost", "filtering", "logs"],
    authorName: null,
    sourceUrl: null,
  },
  {
    slug: "kubernetes-telemetry-stack",
    name: "Kubernetes Telemetry Stack",
    sortOrder: 20,
    telfloAppPin: "0.147.0",
    version: "0.162.0",
    yaml: { sha256: "7bd016efbb92b744ee384944c21414bd8c0bc7c117e5e8abcd8bcca12b838fb6", length: 3889 },
    summarySha256: "faa1c6948d77606d710c7b83c0a7eb9d29be548234fa93f49700ec9862c76e3f",
    descriptionSha256: "c8aaebc5c963aed5658210a679f14cd399d671ed608289cc034b58a969f5ba44",
    signals: ["metrics", "logs"],
    tags: ["kubernetes", "collection", "daemonset"],
    authorName: null,
    sourceUrl: null,
  },
  {
    slug: "tail-sampling-keep-errors",
    name: "Tail Sampling: Keep Every Error",
    sortOrder: 30,
    telfloAppPin: "0.147.0",
    version: "0.162.0",
    yaml: { sha256: "58002a73080ee216a269793912e012daa3217ad30f526681e90e74e658e92d27", length: 2553 },
    summarySha256: "5db72b401cf6127673566638d731f73e1a278c1febbf476c72632bc8076c39eb",
    descriptionSha256: "3a5cbd18c1eeb4b85f95e8901afd7bfb484915de722d7b7a086c1890776f189c",
    signals: ["traces", "metrics"],
    tags: ["sampling", "cost", "traces"],
    authorName: null,
    sourceUrl: null,
  },
  {
    slug: "metric-cardinality-firewall",
    name: "Metric Cardinality Firewall",
    sortOrder: 40,
    telfloAppPin: "0.147.0",
    version: "0.162.0",
    yaml: { sha256: "9e0fd1d308187ded8adb4b3b9604b3897b5df72d8830834c734672052995a950", length: 4246 },
    summarySha256: "c4dc2fed5432931953a85252b79c4a555ba086c9921c2f2de7e5f7251bce3be0",
    descriptionSha256: "d8632af94a542ec42730446ea9dc5a78cb4e6231a15b6196190b2f56644cc7e5",
    signals: ["metrics"],
    tags: ["cost", "cardinality", "metrics"],
    authorName: null,
    sourceUrl: null,
  },
  {
    slug: "host-fleet-monitoring",
    name: "Host Fleet Monitoring",
    sortOrder: 50,
    telfloAppPin: "0.147.0",
    version: "0.162.0",
    yaml: { sha256: "7453bdc0a1d0e5660b3a9bea33b76697449302744926cf30de384fe9d9108b1c", length: 3346 },
    summarySha256: "1d427b163c4045c94f5cf91eb0c7c805d3c546fadda1f2323994e3b1d04bcaf4",
    descriptionSha256: "bd18d10765307f6fd9db55aee794e4741d228d6badc51cc07f30a18c7b5ab65d",
    signals: ["metrics", "logs"],
    tags: ["hosts", "collection", "fleet"],
    authorName: null,
    sourceUrl: null,
  },
  {
    slug: "dual-ship-migration-bridge",
    name: "Dual-Ship Migration Bridge",
    sortOrder: 60,
    telfloAppPin: "0.147.0",
    version: "0.162.0",
    yaml: { sha256: "aa77b5f24b5a4ee135eb0d632d0aa3b3e07279a0163fb1f64acd1bbde8cabbc3", length: 3921 },
    summarySha256: "3081ef36858c0647228619213a8fc5850e7ff7f64241806acd17f858a3edc338",
    descriptionSha256: "d819938ba6354a0d4d8183ad967220e2572aa028f27d45023610231079a10015",
    signals: ["traces", "metrics", "logs"],
    tags: ["migration", "datadog", "dual-ship"],
    authorName: null,
    sourceUrl: null,
  },
  {
    slug: "pii-redaction-gateway",
    name: "PII Redaction Gateway",
    sortOrder: 70,
    telfloAppPin: "0.147.0",
    version: "0.162.0",
    yaml: { sha256: "83685e70b553d39799b30f367d11b43dfb698dd6c1cdea5e6d1a448d524cabeb", length: 3820 },
    summarySha256: "167fb3ed94bad8cbaaaf8605724a6fc767454a4262bb2df93b53b906c860fbff",
    descriptionSha256: "cd2ea09bdfc1f39572a561a525a57f1fae3ab839145fb0aa084bdb86310d3a1f",
    signals: ["logs", "traces"],
    tags: ["security", "compliance", "redaction"],
    authorName: null,
    sourceUrl: null,
  },
  {
    slug: "outage-proof-pipeline",
    name: "Outage-Proof Pipeline",
    sortOrder: 80,
    telfloAppPin: "0.147.0",
    version: "0.162.0",
    yaml: { sha256: "5a87f55ca1a3ff589c51e20c6c47df22ebef6db4ad1961ae1ff966c77d9e66c1", length: 3014 },
    summarySha256: "bb463b3f36c6825c0de1a7e85bd7b855c69037c52cde9f26f0fe4f786d2c8d7e",
    descriptionSha256: "1edabca1be5b0e94c4b92958ac17169a35eb0c21c48865cb4783c95c107e5a00",
    signals: ["traces", "metrics", "logs"],
    tags: ["reliability", "queueing", "resilience"],
    authorName: null,
    sourceUrl: null,
  },
  {
    slug: "otel-to-clickstack",
    name: "OTel to ClickStack",
    sortOrder: 90,
    telfloAppPin: "clickstack 2.36.0",
    version: "0.162.0",
    yaml: { sha256: "7a5a354ef8d871bb8c066260cd2d044a416b134e631052c9f225abda88dcdb94", length: 7211 },
    summarySha256: "ef2df8538e3125170c4f994645bcd54d7df1113c02ac5f8d645139db46f31a43",
    descriptionSha256: "721638274162b016bbfce07ad1eb0d34b5a9695f9ea0f5064ca15f56034e65f6",
    signals: ["traces", "metrics", "logs"],
    tags: ["clickhouse", "parsing", "backend"],
    authorName: "ClickStack",
    sourceUrl: "https://github.com/hyperdxio/hyperdx/tree/main/docker/otel-collector",
  },
  {
    slug: "llm-telemetry-gateway",
    name: "LLM Telemetry Gateway",
    sortOrder: 100,
    telfloAppPin: "0.147.0",
    version: "0.162.0",
    yaml: { sha256: "ee42c643e23251fe66fbcbb31d911e95cf5e6b37dfdde2b2d73040f6a5542ec0", length: 4257 },
    summarySha256: "e04ed05d6dab89e9f083aeef8bc96f1b0a424943030785ae5cf7501dd63b8d3b",
    descriptionSha256: "8e64495ac08d2b903148446b798ce5dccb401042a73e5d33a9dbaec4faa2e3ab",
    signals: ["traces", "logs"],
    tags: ["security", "genai", "redaction"],
    authorName: null,
    sourceUrl: null,
  },
  {
    slug: "datadog-to-elastic-migration-bridge",
    name: "Datadog to Elastic Migration Bridge",
    sortOrder: 145,
    telfloAppPin: "0.147.0",
    version: "0.162.0",
    yaml: { sha256: "74cbc1c2810a32134bfb4c4111d706f0e8fc72c34131ffe423045a119388838a", length: 5688 },
    summarySha256: "7b63928602af5527343bcc6919726a93692ee84ef9f792aa32195062034730a4",
    descriptionSha256: "9ebd26d1ff10cae72045e54c96d393ac6ec6424b3874a83d12b36f6132c5a95e",
    signals: ["traces", "metrics", "logs"],
    tags: ["migration", "datadog", "elastic", "dual-ship"],
    authorName: null,
    sourceUrl: null,
  },
  {
    slug: "datadog-to-clickstack-migration-bridge",
    name: "Datadog to ClickStack Migration Bridge",
    sortOrder: 150,
    telfloAppPin: "0.155.0",
    version: "0.162.0",
    yaml: { sha256: "a85acee1854b8623d9f8004654c06dd1950cd3e568aa1c7dd95e3527cb51f1e8", length: 2405 },
    summarySha256: "9fc6a2c866bdbb779fd598be15fa2e798940900a9720f666ac3571198fda7dbf",
    descriptionSha256: "891d8c648b21e40432391172b800082186800605fc92e1357e278934c49f6ee3",
    signals: ["traces", "metrics", "logs"],
    tags: ["migration", "datadog", "clickstack", "dual-ship"],
    authorName: null,
    sourceUrl: null,
  },
  {
    slug: "clickhouse-failover-gateway-s3-overflow",
    name: "ClickHouse failover gateway (S3 overflow)",
    sortOrder: 160,
    telfloAppPin: "0.159.0",
    version: "0.159.0",
    yaml: { sha256: "29d9533be9f9b287aa8aa64f6ecb78ef48a1872b053fa6d98e55334267b8c9b1", length: 3670 },
    summarySha256: "42455201f46300c30bfe2dc75636dc5b80567aa36633bf3c0a0f3128bc20c7fe",
    descriptionSha256: "d424704d5ef0a391a6990b5769b56df9de905624296147386d206cb1233ce60e",
    signals: ["traces", "metrics", "logs"],
    tags: ["clickstack", "gateway", "logs", "trace", "metrics", "s3", "failover"],
    authorName: "ClickStack",
    sourceUrl: "https://clickhouse.com/blog/reliable-opentelemetry-ingestion-at-scale",
  },
];

/** A Postgres error's code and constraint, to compare with toMatchObject. */
const refusal = (code: string, constraint?: string) => (constraint === undefined ? { code } : { code, constraint });

/** What `work` threw; fails when it threw nothing. */
async function errorOf(work: () => Promise<unknown>): Promise<Error & { code?: string; constraint?: string }> {
  try {
    await work();
  } catch (error) {
    return error as Error & { code?: string; constraint?: string };
  }
  throw new Error("expected a refusal, and the write went through");
}

describe("the flows migration", () => {
  let databases: TestDatabases;
  /** The API's login role. */
  let db: Kysely<Database>;
  /** The tables' owner. */
  let ownerDb: Kysely<Database>;
  let migration: FlowsMigration;

  beforeAll(async () => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    migration = await loadFlowsMigration();
  });

  afterAll(async () => {
    await databases.destroy();
  });

  /**
   * Creates a database named `telflo_<prefix>_<random>_test` and migrates it
   * to the latest migration as the tables' owner: the URL of that owner's
   * connection to it, and its name, to drop afterwards.
   */
  async function createThrowawayDatabase(prefix: string): Promise<{ name: string; ownerUrl: string }> {
    const name = `telflo_${prefix}_${randomUUID().replaceAll("-", "")}_test`;
    const url = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    url.pathname = `/${name}`;
    await sql`create database ${sql.id(name)}`.execute(ownerDb);
    await migrateToLatest(url.toString());
    return { name, ownerUrl: url.toString() };
  }

  describe("the seeded flows", () => {
    let throwawayName: string;
    let throwaway: Kysely<Database>;

    beforeAll(async () => {
      const created = await createThrowawayDatabase("seeded_flows");
      throwawayName = created.name;
      throwaway = createDb(createPool(created.ownerUrl));
    }, THROWAWAY_DATABASE_TIMEOUT);

    afterAll(async () => {
      await throwaway?.destroy();
      await sql`drop database if exists ${sql.id(throwawayName)}`.execute(ownerDb);
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    /** Every flow's columns but its id and timestamps, by slug. */
    const stored = async (connection: Kysely<Database>) =>
      connection
        .selectFrom("flows")
        .select([
          "slug",
          "name",
          "summary",
          "description",
          "source",
          "author_name",
          "author_url",
          "signals",
          "tags",
          "yaml_content",
          "collector_distribution",
          "collector_version",
          "source_url",
          "published",
          "sort_order",
        ])
        .orderBy("slug")
        .execute();

    it("holds the 13 seeded flows by slug, each text byte for byte by SHA-256 and length, re-pinned to otelcol-contrib 0.162.0 (0.159.0 for clickhouse-failover-gateway-s3-overflow), every other column as seeded", async () => {
      // Hashed by Postgres, of the text it stores.
      const { rows } = await sql`
        select slug, name, sort_order as "sortOrder", collector_distribution as distribution,
               collector_version as version,
               encode(sha256(convert_to(yaml_content, 'UTF8')), 'hex') as "yamlSha256",
               char_length(yaml_content) as "yamlLength",
               encode(sha256(convert_to(summary, 'UTF8')), 'hex') as "summarySha256",
               encode(sha256(convert_to(description, 'UTF8')), 'hex') as "descriptionSha256",
               signals, tags, source, author_name as "authorName", author_url as "authorUrl",
               source_url as "sourceUrl", published
          from flows order by slug
      `.execute(throwaway);
      const expected = expectedSeededFlows
        .map((flow) => ({
          slug: flow.slug,
          name: flow.name,
          sortOrder: flow.sortOrder,
          distribution: "otelcol-contrib",
          version: flow.version,
          yamlSha256: flow.yaml.sha256,
          yamlLength: flow.yaml.length,
          summarySha256: flow.summarySha256,
          descriptionSha256: flow.descriptionSha256,
          signals: flow.signals,
          tags: flow.tags,
          source: "telflo",
          authorName: flow.authorName,
          authorUrl: null,
          sourceUrl: flow.sourceUrl,
          published: true,
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
      expect(rows).toEqual(expected);
      expect(rows.filter((row) => (row as { version: string }).version === "0.159.0")).toEqual([
        expect.objectContaining({ slug: "clickhouse-failover-gateway-s3-overflow" }),
      ]);
    });

    it("stores exactly the migration's constant, every column, each YAML ASCII, ending in exactly one newline and naming ${…}; both timestamps the migration's, to the millisecond", async () => {
      const constant = [...migration.seededFlows].sort((a, b) => a.slug.localeCompare(b.slug));
      expect(await stored(throwaway)).toEqual(
        constant.map((flow) => ({ ...flow, signals: [...flow.signals], tags: [...flow.tags] })),
      );
      for (const flow of migration.seededFlows) {
        expect({
          slug: flow.slug,
          ascii: [...flow.yaml_content].every((character) => character.charCodeAt(0) < 0x80),
        }).toEqual({ slug: flow.slug, ascii: true });
        expect({ slug: flow.slug, ending: flow.yaml_content.slice(-2) }).toEqual({
          slug: flow.slug,
          ending: expect.stringMatching(/^[^\n]\n$/),
        });
        expect(flow.yaml_content).toContain("${");
      }
      const { rows } = await sql<{ same: boolean; whole: boolean }>`
        select bool_and(created_at = updated_at) as same,
               bool_and(created_at = date_trunc('milliseconds', created_at)) as whole
          from flows
      `.execute(throwaway);
      expect(rows).toEqual([{ same: true, whole: true }]);
    });

    it("freezes the constant, each flow and its lists", () => {
      expect(Object.isFrozen(migration.seededFlows)).toBe(true);
      expect(migration.seededFlows).toHaveLength(13);
      for (const flow of migration.seededFlows) {
        expect([Object.isFrozen(flow), Object.isFrozen(flow.signals), Object.isFrozen(flow.tags)]).toEqual([
          true,
          true,
          true,
        ]);
      }
    });

    it("the insert's dollar quoting refuses a text holding its tag, or ending with all of it but its last $, and writes any other text as it is", async () => {
      const [first] = migration.seededFlows as [SeededFlow];
      for (const flow of [
        { ...first, yaml_content: "receivers: {}\n# $seeded_flow$\n" },
        { ...first, summary: "ends with $seeded_flow" },
        { ...first, tags: ["$seeded_flow$"] },
        { ...first, author_name: "$seeded_flow$" },
      ]) {
        expect(() => migration.flowsInsert([flow])).toThrow(/holds the quoting tag \$seeded_flow\$/);
      }

      const awkward: SeededFlow = {
        ...first,
        slug: "awkward-text",
        name: "It's 'quoted', \\ back\\slashed, $$ dollared",
        summary: "a $seeded_flow b, $$ and seeded_flow$",
        description: "E'\\n' stays four characters; ${env:X} stays too\r\n",
        tags: ["it's", "$$", "\\"],
      };
      await sql.raw(migration.flowsInsert([awkward])).execute(throwaway);
      try {
        const rows = await stored(throwaway);
        expect(rows.find((row) => row.slug === "awkward-text")).toEqual({
          ...awkward,
          signals: [...awkward.signals],
          tags: [...awkward.tags],
        });
      } finally {
        await throwaway.deleteFrom("flows").where("slug", "=", "awkward-text").execute();
      }
    });

    it("the seeded flows' insert, run twice more, inserts nothing and changes no flow, an admin's edit included; a deleted flow comes back as seeded", async () => {
      await throwaway
        .updateTable("flows")
        .set({
          name: "PII Redaction Gateway (edited)",
          yaml_content: "receivers: {}\n",
          published: false,
          updated_at: new Date("2030-01-02T03:04:05.678Z"),
        })
        .where("slug", "=", "pii-redaction-gateway")
        .execute();
      const edited = await throwaway.selectFrom("flows").selectAll().orderBy("slug").execute();

      for (const run of [1, 2]) {
        const result = await sql.raw(migration.seededFlowsInsert()).execute(throwaway);
        expect({ run, inserted: result.numAffectedRows }).toEqual({ run, inserted: 0n });
      }
      expect(await throwaway.selectFrom("flows").selectAll().orderBy("slug").execute()).toEqual(edited);

      await throwaway.deleteFrom("flows").where("slug", "=", "log-volume-cost-control").execute();
      const result = await sql.raw(migration.seededFlowsInsert()).execute(throwaway);
      expect(result.numAffectedRows).toEqual(1n);
      const after = await throwaway.selectFrom("flows").selectAll().orderBy("slug").execute();
      expect(after.filter((flow) => flow.slug !== "log-volume-cost-control")).toEqual(
        edited.filter((flow) => flow.slug !== "log-volume-cost-control"),
      );
      const restored = (await stored(throwaway)).find((flow) => flow.slug === "log-volume-cost-control");
      const seeded = migration.seededFlows.find((flow) => flow.slug === "log-volume-cost-control")!;
      expect(restored).toEqual({ ...seeded, signals: [...seeded.signals], tags: [...seeded.tags] });
    });
  });

  /*
   * The tables' owner in the tests (and in compose) is telflo, a superuser,
   * whom pg_has_role counts a member of every role: the owner cases below in
   * telflo_platform_test pass for that reason alone. Here the users table belongs to a
   * NOSUPERUSER login role, as a self-hoster's migration role may, so the
   * trigger's rule is shown on its own terms: membership of the table's
   * owner, not superuser.
   */
  describe("the product-admin flag with an owner who is not a superuser", () => {
    let throwawayName: string;
    /** The NOSUPERUSER login role that owns users in the throwaway database. */
    let ownerRole: string;
    /** Connected as `ownerRole`. */
    let asOwner: Kysely<Database>;
    /** Connected as the API's login role. */
    let asApi: Kysely<Database>;
    /** Connected as telflo_platform_owner, the superuser who made the throwaway database, to read rows back. */
    let asSuperuser: Kysely<Database>;
    let userId: string;

    beforeAll(async () => {
      const created = await createThrowawayDatabase("flag_owner");
      throwawayName = created.name;
      asSuperuser = createDb(createPool(created.ownerUrl));

      ownerRole = `telflo_flag_owner_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const password = `flag-owner-${randomUUID()}`;
      await sql
        .raw(
          `create role ${pg.escapeIdentifier(ownerRole)} login nosuperuser nocreatedb nocreaterole ` +
            `password ${pg.escapeLiteral(password)}`,
        )
        .execute(ownerDb);
      await sql`grant connect on database ${sql.id(throwawayName)} to ${sql.id(ownerRole)}`.execute(asSuperuser);
      await sql`grant usage on schema platform to ${sql.id(ownerRole)}`.execute(asSuperuser);
      await sql`alter table users owner to ${sql.id(ownerRole)}`.execute(asSuperuser);

      const ownerUrl = new URL(created.ownerUrl);
      ownerUrl.username = ownerRole;
      ownerUrl.password = password;
      asOwner = createDb(createPool(ownerUrl.toString()));

      const apiUrl = new URL(process.env.TELFLO_DATABASE_URL!);
      apiUrl.pathname = `/${throwawayName}`;
      asApi = createDb(createPool(apiUrl.toString()));

      userId = (await createUserWithOrganization(asSuperuser)).user.id;
    }, THROWAWAY_DATABASE_TIMEOUT);

    afterAll(async () => {
      await Promise.all([asOwner?.destroy(), asApi?.destroy(), asSuperuser?.destroy()]);
      await sql`drop database if exists ${sql.id(throwawayName)}`.execute(ownerDb);
      if (ownerRole !== undefined) await sql`drop role if exists ${sql.id(ownerRole)}`.execute(ownerDb);
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    const flagOf = async (id: string) =>
      (await asSuperuser.selectFrom("users").select("is_product_admin").where("id", "=", id).executeTakeFirstOrThrow())
        .is_product_admin;

    it("owns users, is no superuser, and is the role the trigger sees", async () => {
      const { rows } = await sql<{ owner: string; superuser: boolean; current: string }>`
        select c.relowner::regrole::text as owner, r.rolsuper as superuser, current_user as current
          from pg_class c join pg_roles r on r.oid = c.relowner
         where c.oid = to_regclass('users')
      `.execute(asOwner);
      expect(rows).toEqual([{ owner: ownerRole, superuser: false, current: ownerRole }]);
    });

    it("lets that owner set the flag and clear it, while the API's role is refused both (42501) and the flag stays", async () => {
      await expect(
        asApi.updateTable("users").set({ is_product_admin: true }).where("id", "=", userId).execute(),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await flagOf(userId)).toBe(false);

      await asOwner.updateTable("users").set({ is_product_admin: true }).where("id", "=", userId).execute();
      expect(await flagOf(userId)).toBe(true);

      await expect(
        asApi.updateTable("users").set({ is_product_admin: false }).where("id", "=", userId).execute(),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await flagOf(userId)).toBe(true);

      await asOwner.updateTable("users").set({ is_product_admin: false }).where("id", "=", userId).execute();
      expect(await flagOf(userId)).toBe(false);
    });
  });

  describe("in telflo_platform_test", () => {
    beforeEach(async () => {
      await truncateAll(ownerDb);
    });

    describe("the flows table", () => {
      let defaultDistribution: string;

      beforeAll(async () => {
        defaultDistribution = (await catalogueDefaults(ownerDb)).distribution;
      });

      /** A valid flow's columns, as the API would write them, with `overrides`. */
      const flowValues = (overrides: Record<string, unknown> = {}) => {
        const now = new Date();
        return {
          slug: `flow-${randomUUID()}`,
          name: "A Flow",
          summary: "Does one thing.",
          description: "Does one thing, well.",
          source: "telflo",
          yaml_content: "receivers: {}\n",
          collector_distribution: defaultDistribution,
          collector_version: "0.162.0",
          created_at: now,
          updated_at: now,
          ...overrides,
        } as Insertable<FlowsTable>;
      };

      /** Inserts a flow as `connection` (the owner by default) and returns it. */
      const addFlow = (overrides: Record<string, unknown> = {}, connection: Kysely<Database> = ownerDb) =>
        connection.insertInto("flows").values(flowValues(overrides)).returningAll().executeTakeFirstOrThrow();

      it("accepts a valid flow with the defaults: published, sort order 0, no signals, no tags, no author, no source link", async () => {
        const flow = await addFlow();
        expect(flow).toMatchObject({
          published: true,
          sort_order: 0,
          signals: [],
          tags: [],
          author_name: null,
          author_url: null,
          source_url: null,
        });
        expect(flow.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
      });

      it("refuses a slug that isn't kebab-case (23514, ck_flows_slug_format), and accepts one that is", async () => {
        for (const slug of [
          "Upper-Case",
          "with space",
          "-leading",
          "trailing-",
          "double--hyphen",
          "under_score",
          "dot.ted",
          "ümlaut",
          "",
        ]) {
          expect({ slug, error: await errorOf(() => addFlow({ slug })) }).toEqual({
            slug,
            error: expect.objectContaining(refusal("23514", "ck_flows_slug_format")),
          });
        }
        for (const slug of ["a", "0-1", "pii-redaction-gateway", "otel-to-clickstack-2"]) {
          await expect(addFlow({ slug })).resolves.toMatchObject({ slug });
        }
      });

      it("accepts an 80-character slug and refuses an 81-character one (23514, ck_flows_slug_length)", async () => {
        const eighty = `${"a-".repeat(39)}ab`;
        expect(eighty).toHaveLength(80);
        await expect(addFlow({ slug: eighty })).resolves.toMatchObject({ slug: eighty });
        await expect(addFlow({ slug: `${eighty}c` })).rejects.toMatchObject(refusal("23514", "ck_flows_slug_length"));
      });

      it("refuses a second flow with a slug already taken (23505, uq_flows_slug)", async () => {
        await addFlow({ slug: "pii-redaction-gateway" });
        await expect(addFlow({ slug: "pii-redaction-gateway" })).rejects.toMatchObject(
          refusal("23505", "uq_flows_slug"),
        );
      });

      it("refuses a source but telflo or community (23514, ck_flows_source)", async () => {
        for (const source of ["Telflo", "other", ""]) {
          expect({ source, error: await errorOf(() => addFlow({ source })) }).toEqual({
            source,
            error: expect.objectContaining(refusal("23514", "ck_flows_source")),
          });
        }
        await expect(addFlow({ source: "community" })).resolves.toMatchObject({ source: "community" });
        await expect(addFlow({ source: null })).rejects.toMatchObject(refusal("23502"));
      });

      it("refuses a source link but none or an http(s) URL (23514, ck_flows_source_url_scheme)", async () => {
        for (const sourceUrl of [
          "javascript:alert(1)",
          "data:text/html,<p>",
          "ftp://example.com/x",
          "//example.com",
          " https://example.com",
          "",
        ]) {
          expect({ sourceUrl, error: await errorOf(() => addFlow({ source_url: sourceUrl })) }).toEqual({
            sourceUrl,
            error: expect.objectContaining(refusal("23514", "ck_flows_source_url_scheme")),
          });
        }
        for (const sourceUrl of [null, "http://example.com", "https://github.com/hyperdxio/hyperdx"]) {
          await expect(addFlow({ source_url: sourceUrl })).resolves.toMatchObject({ source_url: sourceUrl });
        }
      });

      it("refuses a blank collector version (23514, ck_flows_collector_version_present), and none (23502)", async () => {
        for (const version of ["", "   "]) {
          await expect(addFlow({ collector_version: version })).rejects.toMatchObject(
            refusal("23514", "ck_flows_collector_version_present"),
          );
        }
        await expect(addFlow({ collector_version: null })).rejects.toMatchObject(refusal("23502"));
        // No foreign key on the version: a pin the catalogue doesn't hold is the API's to refuse.
        await expect(addFlow({ collector_version: "0.147.0" })).resolves.toMatchObject({
          collector_version: "0.147.0",
        });
      });

      it("refuses signals but traces, metrics and logs, each at most once (23514, ck_flows_signals: migration 1700000000027), and accepts any set of them in any order", async () => {
        for (const signals of [
          ["profiles"],
          ["traces", "profiles"],
          ["Traces"],
          ["logs "],
          [""],
          [null],
          ["traces", "traces"],
          ["logs", "metrics", "logs"],
          ["traces", "metrics", "logs", "traces"],
          [["traces"], ["logs"]],
        ]) {
          expect({ signals, error: await errorOf(() => addFlow({ signals })) }).toEqual({
            signals,
            error: expect.objectContaining(refusal("23514", "ck_flows_signals")),
          });
        }
        for (const signals of [[], ["logs"], ["metrics", "logs"], ["logs", "traces"], ["traces", "metrics", "logs"], ["logs", "metrics", "traces"]]) {
          await expect(addFlow({ signals })).resolves.toMatchObject({ signals });
        }
        // Updates are checked too, by the API's role as by the owner.
        const flow = await addFlow({ signals: ["traces"] });
        await expect(
          db.updateTable("flows").set({ signals: ["traces", "logs", "spans"] }).where("id", "=", flow.id).execute(),
        ).rejects.toMatchObject(refusal("23514", "ck_flows_signals"));
      });

      it("passes the 13 seeded flows through ck_flows_signals: they insert, and rewriting every row's signals rechecks them", async () => {
        await insertSeededFlows(ownerDb);
        const rewritten = await sql`update flows set signals = signals`.execute(ownerDb);
        expect(Number(rewritten.numAffectedRows)).toBe(13);
        const { rows } = await sql<{ validated: boolean }>`
          select convalidated as validated from pg_constraint
           where conrelid = to_regclass('flows') and conname = 'ck_flows_signals'
        `.execute(ownerDb);
        expect(rows).toEqual([{ validated: true }]);
      });

      it("refuses a distribution the catalogue doesn't hold (23503, fk_flows_collector_distribution), and none (23502)", async () => {
        await expect(addFlow({ collector_distribution: "clickstack" })).rejects.toMatchObject(
          refusal("23503", "fk_flows_collector_distribution"),
        );
        await expect(addFlow({ collector_distribution: null })).rejects.toMatchObject(refusal("23502"));
      });

      it("has no default for either timestamp (23502): the API writes them from its clock", async () => {
        for (const column of ["created_at", "updated_at"]) {
          const { [column]: _left, ...values } = flowValues() as Record<string, unknown>;
          expect({
            column,
            error: await errorOf(() =>
              ownerDb
                .insertInto("flows")
                .values(values as Insertable<FlowsTable>)
                .execute(),
            ),
          }).toEqual({ column, error: expect.objectContaining(refusal("23502")) });
        }
      });

      it("has no row-level security: the API's role reads, creates, changes and deletes any flow with no database context", async () => {
        const { rows } = await sql<{ rls: boolean; force: boolean }>`
          select relrowsecurity as rls, relforcerowsecurity as force from pg_class where oid = to_regclass('flows')
        `.execute(ownerDb);
        expect(rows).toEqual([{ rls: false, force: false }]);

        const seeded = await addFlow({ published: false });
        const created = await addFlow({}, db);
        expect((await db.selectFrom("flows").select("id").orderBy("id").execute()).map((row) => row.id)).toEqual(
          [seeded.id, created.id].sort(),
        );
        await db.updateTable("flows").set({ published: true }).where("id", "=", seeded.id).execute();
        await db.deleteFrom("flows").where("id", "=", created.id).execute();
        expect(await ownerDb.selectFrom("flows").select(["id", "published"]).execute()).toEqual([
          { id: seeded.id, published: true },
        ]);
      });

      it("insertSeededFlows puts the migration's 13 flows back after truncateAll, and a second call inserts nothing", async () => {
        expect(await ownerDb.selectFrom("flows").select("slug").execute()).toEqual([]);
        await insertSeededFlows(ownerDb);
        await insertSeededFlows(ownerDb);
        const rows = await ownerDb.selectFrom("flows").select(["slug", "yaml_content"]).orderBy("sort_order").execute();
        expect(rows).toEqual(
          migration.seededFlows.map((flow) => ({ slug: flow.slug, yaml_content: flow.yaml_content })),
        );
      });
    });

    describe("the product-admin flag", () => {
      /** Every write here runs in a transaction rolled back whatever happens. */
      const rollback = new Error("rollback");
      const rolledBack = async (
        connection: Kysely<Database>,
        work: (transaction: Kysely<Database>) => Promise<unknown>,
      ) => {
        try {
          await connection.transaction().execute(async (transaction) => {
            await work(transaction);
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
      };

      /** A user the owner made a product admin. */
      const addProductAdmin = async () =>
        (await createUserWithOrganization(ownerDb, { user: { is_product_admin: true } })).user;

      const flagOf = async (userId: string) =>
        (
          await ownerDb
            .selectFrom("users")
            .select("is_product_admin")
            .where("id", "=", userId)
            .executeTakeFirstOrThrow()
        ).is_product_admin;

      /** The refusal's message: it names the user's id and nothing else of theirs. */
      const ownerOnly = (userId: string) =>
        `only the tables' owner sets or clears the product-admin flag of user ${userId}`;

      it("is false for a new user", async () => {
        const { user } = await createUserWithOrganization(ownerDb);
        expect(user.is_product_admin).toBe(false);
      });

      it("refuses the API's role an insert with the flag set (42501), naming only the user's id", async () => {
        const email = `smuggled-${randomUUID()}@example.com`;
        const error = await errorOf(() =>
          db
            .insertInto("users")
            .values({
              email,
              accepted_terms_version: "2026-01-01",
              terms_accepted_at: new Date(),
              is_product_admin: true,
            })
            .execute(),
        );
        expect(error).toMatchObject({ code: "42501" });
        expect(error.message).toMatch(
          /^only the tables' owner sets or clears the product-admin flag of user [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(error.message).not.toContain(email);
        expect(await ownerDb.selectFrom("users").select("id").where("email", "=", email).execute()).toEqual([]);
      });

      it("refuses the API's role an update that sets, clears or flips the flag (42501), naming only the user's id, and the flag stays", async () => {
        const { user } = await createUserWithOrganization(ownerDb);
        const admin = await addProductAdmin();

        await expect(
          db.updateTable("users").set({ is_product_admin: true }).where("id", "=", user.id).execute(),
        ).rejects.toMatchObject({ code: "42501", message: ownerOnly(user.id) });
        await expect(
          db.updateTable("users").set({ is_product_admin: false }).where("id", "=", admin.id).execute(),
        ).rejects.toMatchObject({ code: "42501", message: ownerOnly(admin.id) });
        await expect(sql`update users set is_product_admin = not is_product_admin`.execute(db)).rejects.toMatchObject({
          code: "42501",
        });
        expect([await flagOf(user.id), await flagOf(admin.id)]).toEqual([false, true]);
      });

      it("lets the API's role write the flag's own value, and every other column, on a product admin's row and anyone's", async () => {
        const { user } = await createUserWithOrganization(ownerDb);
        const admin = await addProductAdmin();
        await db.updateTable("users").set({ is_product_admin: false }).where("id", "=", user.id).execute();
        await db.updateTable("users").set({ is_product_admin: true }).where("id", "=", admin.id).execute();
        const at = new Date("2030-01-02T03:04:05.678Z");
        await db
          .updateTable("users")
          .set({
            email_verified_at: at,
            password_hash: "$argon2id$changed",
            accepted_terms_version: "2030-01-01",
            terms_accepted_at: at,
            updated_at: at,
          })
          .where("id", "in", [user.id, admin.id])
          .execute();
        const rows = await ownerDb
          .selectFrom("users")
          .select(["id", "is_product_admin", "accepted_terms_version"])
          .where("id", "in", [user.id, admin.id])
          .execute();
        expect(rows).toEqual(
          expect.arrayContaining([
            { id: user.id, is_product_admin: false, accepted_terms_version: "2030-01-01" },
            { id: admin.id, is_product_admin: true, accepted_terms_version: "2030-01-01" },
          ]),
        );
      });

      it("refuses the API's role every way around the trigger (42501): disabling or dropping it, replacing its function, replica mode, becoming the owner, dropping the column", async () => {
        const { rows } = await sql<{ owner: string }>`
          select relowner::regrole::text as owner from pg_class where oid = to_regclass('users')
        `.execute(ownerDb);
        const owner = rows[0]!.owner;
        for (const statement of [
          sql`alter table users disable trigger users_product_admin_owner_only`,
          sql`alter table users disable trigger all`,
          sql`drop trigger users_product_admin_owner_only on users`,
          sql.raw(
            "create or replace function refuse_product_admin_change() returns trigger language plpgsql " +
              "as $$ begin return new; end $$",
          ),
          sql`set session_replication_role = replica`,
          sql`set role ${sql.id(owner)}`,
          sql`alter table users drop column is_product_admin`,
        ]) {
          let error: unknown;
          await rolledBack(db, async (transaction) => {
            error = await errorOf(() => statement.execute(transaction));
          });
          expect({ statement: statement.compile(db).sql, error }).toEqual({
            statement: statement.compile(db).sql,
            error: expect.objectContaining({ code: "42501" }),
          });
        }
        const { user } = await createUserWithOrganization(ownerDb);
        await expect(
          db.updateTable("users").set({ is_product_admin: true }).where("id", "=", user.id).execute(),
        ).rejects.toMatchObject({ code: "42501" });
      });

      it("lets the tables' owner set it, clear it, and insert a product admin", async () => {
        const { user } = await createUserWithOrganization(ownerDb);
        await ownerDb.updateTable("users").set({ is_product_admin: true }).where("id", "=", user.id).execute();
        expect(await flagOf(user.id)).toBe(true);
        await ownerDb.updateTable("users").set({ is_product_admin: false }).where("id", "=", user.id).execute();
        expect(await flagOf(user.id)).toBe(false);
        const admin = await addProductAdmin();
        expect(admin.is_product_admin).toBe(true);
      });
    });

    describe("configurations.source_flow_slug", () => {
      it("is null when left out, takes any text, and has no foreign key: deleting the flow it names leaves the configuration as it was", async () => {
        const { organization } = await createUserWithOrganization(ownerDb);
        expect((await addConfiguration(ownerDb, { organizationId: organization.id })).source_flow_slug).toBeNull();
        for (const slug of ["pii-redaction-gateway", "Not A Slug!", "", "no-such-flow"]) {
          const configuration = await addConfiguration(ownerDb, {
            organizationId: organization.id,
            source_flow_slug: slug,
          });
          expect(configuration.source_flow_slug).toBe(slug);
        }

        const { rows } = await sql<{ name: string }>`
          select con.conname::text as name
            from pg_constraint con
            join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
           where con.conrelid = to_regclass('configurations') and a.attname = 'source_flow_slug'
        `.execute(ownerDb);
        expect(rows).toEqual([]);

        const now = new Date();
        await ownerDb
          .insertInto("flows")
          .values({
            slug: "retired-flow",
            name: "Retired",
            summary: "s",
            description: "d",
            source: "telflo",
            yaml_content: "receivers: {}\n",
            collector_distribution: (await catalogueDefaults(ownerDb)).distribution,
            collector_version: "0.162.0",
            created_at: now,
            updated_at: now,
          })
          .execute();
        const configuration = await addConfiguration(ownerDb, {
          organizationId: organization.id,
          source_flow_slug: "retired-flow",
        });
        await ownerDb.deleteFrom("flows").where("slug", "=", "retired-flow").execute();
        expect(
          await ownerDb.selectFrom("configurations").selectAll().where("id", "=", configuration.id).executeTakeFirst(),
        ).toEqual(configuration);
      });
    });
  });
});
