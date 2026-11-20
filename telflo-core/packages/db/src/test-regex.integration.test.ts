import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Insertable, type Kysely } from "kysely";
import { migrateToLatest } from "./migrations.js";
import { createDb, createPool } from "./pool.js";
import type { Database, TestRegexTable } from "./schema.js";
import { THROWAWAY_DATABASE_DROP_TIMEOUT } from "./test-database.js";
import {
  insertSeededTestRegexes,
  loadTestRegexMigration,
  openTestDatabases,
  truncateAll,
  type SeededTestRegex,
  type TestDatabases,
  type TestRegexMigration,
} from "./testing.js";

/*
 * Migration 1700000000031: the regex library's table, its checks and its 35
 * seeded entries. Its up, down and up again are schema.integration.test.ts's
 * ("the test regex migration …"); the seed's equality with regex-library.ts is
 * the web's regex-library.test.ts's, over the fixture
 * seeded-test-regexes-fixture.test.ts keeps fresh, and each pattern's RE2
 * compile the evaluator's seeded_test_regexes_test.go's.
 *
 * The seeded entries are checked on a throwaway database migrated to the
 * latest migration: truncateAll empties them from telflo_platform_test before every
 * test.
 */

/** Creating and dropping a database waits for a checkpoint. */
const THROWAWAY_DATABASE_TIMEOUT = 30_000;

/**
 * Each seeded regex as an SQL literal writes it, in its order: the literal's
 * text, raw (standard strings: a backslash is itself; `''` is one quote), so
 * a backslash lost or doubled anywhere between the migration and the database
 * fails here.
 */
const telfloAppRegexes: readonly [name: string, regex: string][] = [
  ["Email Address", String.raw`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`],
  ["Phone Number (International)", String.raw`\+?[0-9]{10,15}`],
  ["US Social Security Number", String.raw`\d{3}-\d{2}-\d{4}`],
  ["EU Passport Number", String.raw`[A-Z]{1,2}[0-9]{6,9}`],
  ["IPv4 Address", String.raw`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`],
  ["IPv6 Address", String.raw`([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}`],
  ["Credit Card", String.raw`\b(?:4\d{3}(?:[- ]?\d{4}){3}|4\d{12}|5[1-5]\d{2}(?:[- ]?\d{4}){3}|3[47]\d{2}[- ]?\d{6}[- ]?\d{5}|(?:6011|65\d{2})(?:[- ]?\d{4}){3})\b`],
  ["CVV Code", String.raw`\b\d{3,4}\b`],
  ["US National Provider ID (NPI)", String.raw`\b[0-9]{10}\b`],
  ["Medical Record Number", String.raw`MRN[:\s-]?[0-9]{6,12}`],
  ["Health Insurance ID", String.raw`[A-Z]{2,3}[0-9]{8,12}`],
  ["Date of Birth (US)", String.raw`\b(0[1-9]|1[0-2])/(0[1-9]|[12][0-9]|3[01])/(19|20)\d{2}\b`],
  ["ICD-10 Code", String.raw`[A-Z][0-9]{2}\.?[0-9A-Z]{0,4}`],
  ["API Key (Generic)", String.raw`(api[_-]?key|apikey)[\s:="']+[a-zA-Z0-9_\-]{16,}`],
  ["JWT Token", String.raw`eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*`],
  ["UUID", String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`],
  ["AWS Access Key", String.raw`AKIA[0-9A-Z]{16}`],
  ["Private Key Header", String.raw`-----BEGIN (RSA |EC )?PRIVATE KEY-----`],
  ["API Key (key match)", String.raw`.*api[_-]?key.*`],
  ["Auth Token (key match)", String.raw`.*token.*`],
  ["Password (key match)", String.raw`.*password.*`],
  ["Secret (key match)", String.raw`.*secret.*`],
  ["Admin/Internal Routes", String.raw`^/(admin|internal)/.*`],
  ["Health Check Routes", String.raw`^/(health|ready|live).*`],
  ["API Routes", String.raw`^/api/.*`],
  ["Password in URL Query", String.raw`password=([^&]+)`],
  ["Password in Command Line", String.raw`password\=([^\s]*)`],
  ["URL Protocol + Domain + Path", String.raw`^(?P<http_protocol>.*?)://(?P<http_domain>.*?)/`],
  ["URL Protocol + Domain", String.raw`^(?P<protocol>https?)://(?P<domain>[^/]+)`],
  ["Generic Log Line (timestamp/level/message)", String.raw`^(?P<timestamp>\S+) (?P<level>\w+) (?P<message>.*)$`],
  ["Date-Prefixed Log Line", String.raw`^(?P<time>\d{4}-\d{2}-\d{2}) (?P<msg>.*)$`],
  ["Generic Prefix", String.raw`^prefix_.*`],
  ["Temp Prefix", String.raw`^temp_.*`],
  ["PII Prefix", String.raw`^pii_.*`],
  ["ISO Date (YYYY-MM-DD)", String.raw`\d{4}-\d{2}-\d{2}`],
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

/** A column's every value but the timestamps', in the seed's terms. */
const fields = (row: { name: string; category: string; description: string | null; regex: string }) => ({
  name: row.name,
  category: row.category,
  description: row.description,
  regex: row.regex,
});

describe("the test regex migration", () => {
  let databases: TestDatabases;
  /** The API's login role. */
  let db: Kysely<Database>;
  /** The tables' owner. */
  let ownerDb: Kysely<Database>;
  let migration: TestRegexMigration;

  beforeAll(async () => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    migration = await loadTestRegexMigration();
  });

  afterAll(async () => {
    await databases.destroy();
  });

  describe("the seeded entries", () => {
    let throwawayName: string;
    let throwaway: Kysely<Database>;

    beforeAll(async () => {
      throwawayName = `telflo_seeded_test_regexes_${randomUUID().replaceAll("-", "")}_test`;
      const url = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
      url.pathname = `/${throwawayName}`;
      await sql`create database ${sql.id(throwawayName)}`.execute(ownerDb);
      await migrateToLatest(url.toString());
      throwaway = createDb(createPool(url.toString()));
    }, THROWAWAY_DATABASE_TIMEOUT);

    afterAll(async () => {
      await throwaway?.destroy();
      await sql`drop database if exists ${sql.id(throwawayName)}`.execute(ownerDb);
    }, THROWAWAY_DATABASE_DROP_TIMEOUT);

    /** Every entry's columns but its id and timestamps, by name. */
    const stored = async () =>
      (
        await throwaway.selectFrom("test_regex").select(["name", "category", "description", "regex"]).execute()
      ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const byName = <Row extends { name: string }>(rows: readonly Row[]) =>
      [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    it("holds the migration's 35 entries, every column, both timestamps the migration's to the millisecond", async () => {
      expect(await stored()).toEqual(byName(migration.seededTestRegexes.map(fields)));
      const { rows } = await sql<{ count: number; same: boolean; whole: boolean }>`
        select count(*)::int as count, bool_and(created_at = updated_at) as same,
               bool_and(created_at = date_trunc('milliseconds', created_at)) as whole
          from test_regex
      `.execute(throwaway);
      expect(rows).toEqual([{ count: 35, same: true, whole: true }]);
    });

    it("reads every regex back byte for byte as the seed writes it, each backslash one byte", async () => {
      // Hex of the bytes Postgres stores, so neither the driver nor JSON stands between.
      const { rows } = await sql<{ name: string; hex: string; backslashes: number }>`
        select name, encode(convert_to(regex, 'UTF8'), 'hex') as hex,
               char_length(regex) - char_length(replace(regex, E'\\\\', '')) as backslashes
          from test_regex
      `.execute(throwaway);
      const expected = telfloAppRegexes.map(([name, regex]) => ({
        name,
        hex: Buffer.from(regex, "utf8").toString("hex"),
        backslashes: [...regex].filter((character) => character === "\\").length,
      }));
      expect(byName(rows)).toEqual(byName(expected));
      expect(expected.filter((entry) => entry.backslashes > 0)).toHaveLength(16);
      expect(telfloAppRegexes.map(([name]) => name)).toEqual(migration.seededTestRegexes.map((entry) => entry.name));
      expect(Object.fromEntries(telfloAppRegexes)["US Social Security Number"]).toBe("\\d{3}-\\d{2}-\\d{4}");
    });

    it("freezes the constant and each entry, every one with a description, every name unique even ignoring case", () => {
      expect(Object.isFrozen(migration.seededTestRegexes)).toBe(true);
      expect(migration.seededTestRegexes).toHaveLength(35);
      for (const entry of migration.seededTestRegexes) {
        expect({ name: entry.name, frozen: Object.isFrozen(entry), keys: Object.keys(entry) }).toEqual({
          name: entry.name,
          frozen: true,
          keys: ["name", "category", "description", "regex"],
        });
        expect(entry.description).toEqual(expect.any(String));
      }
      expect(new Set(migration.seededTestRegexes.map((entry) => entry.name.toLowerCase())).size).toBe(35);
    });

    it("the insert's dollar quoting refuses a text holding its tag, or ending with all of it but its last $, and writes any other text as it is", async () => {
      const [first] = migration.seededTestRegexes as [SeededTestRegex];
      for (const entry of [
        { ...first, regex: "a$seeded_test_regex$b" },
        { ...first, name: "ends with $seeded_test_regex" },
        { ...first, description: "$seeded_test_regex$" },
        { ...first, category: "$seeded_test_regex$" },
      ]) {
        expect(() => migration.testRegexesInsert([entry])).toThrow(/holds the quoting tag \$seeded_test_regex\$/);
      }

      const awkward: SeededTestRegex = {
        name: "It's 'quoted', \\ back\\slashed, $$ dollared",
        category: "a $seeded_test_regex b, $$ and seeded_test_regex$",
        description: null,
        regex: "E'\\n' \\\\d stays as it is; ${env:X} too\\",
      };
      await sql.raw(migration.testRegexesInsert([awkward])).execute(throwaway);
      try {
        expect((await stored()).find((row) => row.name === awkward.name)).toEqual(awkward);
      } finally {
        await throwaway.deleteFrom("test_regex").where("name", "=", awkward.name).execute();
      }
    });

    it("the seeded insert over a database already holding an admin's edit of a seeded entry and an admin's own entry inserts nothing and keeps both; a deleted seeded entry comes back as seeded", async () => {
      await throwaway
        .updateTable("test_regex")
        .set({
          category: "Edited",
          description: null,
          regex: "\\d{9}",
          updated_at: new Date("2030-01-02T03:04:05.678Z"),
        })
        .where("name", "=", "US Social Security Number")
        .execute();
      const now = new Date("2030-02-03T04:05:06.789Z");
      await throwaway
        .insertInto("test_regex")
        .values({
          name: "An admin's own",
          category: "Mine",
          description: "Kept",
          regex: "mine\\.",
          created_at: now,
          updated_at: now,
        })
        .execute();
      const before = await throwaway.selectFrom("test_regex").selectAll().orderBy("id").execute();
      expect(before).toHaveLength(36);

      for (const run of [1, 2]) {
        const result = await sql.raw(migration.seededTestRegexesInsert()).execute(throwaway);
        expect({ run, inserted: result.numAffectedRows }).toEqual({ run, inserted: 0n });
      }
      expect(await throwaway.selectFrom("test_regex").selectAll().orderBy("id").execute()).toEqual(before);

      await throwaway.deleteFrom("test_regex").where("name", "=", "Email Address").execute();
      const result = await sql.raw(migration.seededTestRegexesInsert()).execute(throwaway);
      expect(result.numAffectedRows).toEqual(1n);
      const after = await throwaway.selectFrom("test_regex").selectAll().orderBy("id").execute();
      expect(after.filter((row) => row.name !== "Email Address")).toEqual(
        before.filter((row) => row.name !== "Email Address"),
      );
      expect(fields(after.find((row) => row.name === "Email Address")!)).toEqual(
        fields(migration.seededTestRegexes.find((entry) => entry.name === "Email Address")!),
      );
    });
  });

  describe("in telflo_platform_test", () => {
    beforeEach(async () => {
      await truncateAll(ownerDb);
    });

    /** A valid entry's columns, as the API would write them, with `overrides`. */
    const entryValues = (overrides: Record<string, unknown> = {}) => {
      const now = new Date();
      return {
        name: `Entry ${randomUUID()}`,
        category: "A category",
        description: "Matches something.",
        regex: "\\d+",
        created_at: now,
        updated_at: now,
        ...overrides,
      } as Insertable<TestRegexTable>;
    };

    /** Inserts an entry as `connection` (the owner by default) and returns it. */
    const addEntry = (overrides: Record<string, unknown> = {}, connection: Kysely<Database> = ownerDb) =>
      connection.insertInto("test_regex").values(entryValues(overrides)).returningAll().executeTakeFirstOrThrow();

    /** The refusal of each of `values` for `column`, beside the column and value, to compare at once. */
    const refusals = async (column: string, values: unknown[]) =>
      Promise.all(
        values.map(async (value) => {
          const error = await errorOf(() => addEntry({ [column]: value }));
          return { column, value, code: error.code, constraint: error.constraint };
        }),
      );

    it("accepts a valid entry, with a description or none, and gives it a uuidv7 id", async () => {
      const entry = await addEntry({ description: null });
      expect(entry).toMatchObject({ description: null, category: "A category", regex: "\\d+" });
      expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect((await addEntry()).description).toBe("Matches something.");
    });

    it("refuses a blank, untrimmed or over-long name (23514, ck_test_regex_name_trimmed or _length), and none (23502); accepts 200 characters", async () => {
      const untrimmed = [" ", " a", "a\t", "\na", "a\u000b", "a\f", "\ra"];
      expect(await refusals("name", ["", ...untrimmed, "x".repeat(201), "é".repeat(201)])).toEqual([
        { column: "name", value: "", code: "23514", constraint: "ck_test_regex_name_length" },
        ...untrimmed.map((value) => ({
          column: "name",
          value,
          code: "23514",
          constraint: "ck_test_regex_name_trimmed",
        })),
        { column: "name", value: "x".repeat(201), code: "23514", constraint: "ck_test_regex_name_length" },
        { column: "name", value: "é".repeat(201), code: "23514", constraint: "ck_test_regex_name_length" },
      ]);
      await expect(addEntry({ name: null })).rejects.toMatchObject(refusal("23502"));
      expect((await addEntry({ name: "é".repeat(200) })).name).toBe("é".repeat(200));
      expect((await addEntry({ name: "x".repeat(200) })).name).toBe("x".repeat(200));
      // Unicode's whitespace is the API's check, not the database's.
      expect((await addEntry({ name: " a" })).name).toBe(" a");
    });

    it("refuses a blank, untrimmed or over-long category (23514, ck_test_regex_category_trimmed or _length), and none (23502); accepts 100 characters", async () => {
      expect(await refusals("category", ["", "\t", "a ", "x".repeat(101)])).toEqual([
        { column: "category", value: "", code: "23514", constraint: "ck_test_regex_category_length" },
        { column: "category", value: "\t", code: "23514", constraint: "ck_test_regex_category_trimmed" },
        { column: "category", value: "a ", code: "23514", constraint: "ck_test_regex_category_trimmed" },
        { column: "category", value: "x".repeat(101), code: "23514", constraint: "ck_test_regex_category_length" },
      ]);
      await expect(addEntry({ category: null })).rejects.toMatchObject(refusal("23502"));
      expect((await addEntry({ category: "é".repeat(100) })).category).toBe("é".repeat(100));
    });

    it("refuses a blank, untrimmed or over-long description (23514, ck_test_regex_description_trimmed or _length); accepts 2,000 characters and none", async () => {
      expect(await refusals("description", ["", " ", " a", "a\r\n", "x".repeat(2001)])).toEqual([
        { column: "description", value: "", code: "23514", constraint: "ck_test_regex_description_length" },
        { column: "description", value: " ", code: "23514", constraint: "ck_test_regex_description_trimmed" },
        { column: "description", value: " a", code: "23514", constraint: "ck_test_regex_description_trimmed" },
        { column: "description", value: "a\r\n", code: "23514", constraint: "ck_test_regex_description_trimmed" },
        { column: "description", value: "x".repeat(2001), code: "23514", constraint: "ck_test_regex_description_length" },
      ]);
      expect((await addEntry({ description: "é".repeat(2000) })).description).toBe("é".repeat(2000));
      expect((await addEntry({ description: "a\nb" })).description).toBe("a\nb");
      expect((await addEntry({ description: null })).description).toBeNull();
    });

    it("refuses a blank regex or one past 8,192 bytes (23514, ck_test_regex_regex_length), and none (23502); never trims one, and accepts 8,192 bytes", async () => {
      expect(await refusals("regex", ["", " ", " \t\n\u000b\f\r", "a".repeat(8193), "é".repeat(4096) + "a"])).toEqual(
        ["", " ", " \t\n\u000b\f\r", "a".repeat(8193), "é".repeat(4096) + "a"].map((value) => ({
          column: "regex",
          value,
          code: "23514",
          constraint: "ck_test_regex_regex_length",
        })),
      );
      await expect(addEntry({ regex: null })).rejects.toMatchObject(refusal("23502"));
      // Bytes, not characters: 4,096 two-byte characters are the maximum.
      expect((await addEntry({ regex: "é".repeat(4096) })).regex).toBe("é".repeat(4096));
      expect((await addEntry({ regex: "a".repeat(8192) })).regex).toBe("a".repeat(8192));
      expect((await addEntry({ regex: " \\d+ \n" })).regex).toBe(" \\d+ \n");
    });

    it("refuses a second entry with a name already taken (23505, uq_test_regex_name), compared case and all", async () => {
      await addEntry({ name: "Email Address" });
      await expect(addEntry({ name: "Email Address" })).rejects.toMatchObject(refusal("23505", "uq_test_regex_name"));
      expect((await addEntry({ name: "email address" })).name).toBe("email address");
      expect((await addEntry({ name: "EMAIL ADDRESS" })).name).toBe("EMAIL ADDRESS");
    });

    it("has no default for either timestamp (23502): the API writes them from its clock", async () => {
      for (const column of ["created_at", "updated_at"]) {
        const { [column]: _left, ...values } = entryValues() as Record<string, unknown>;
        expect({
          column,
          error: await errorOf(() =>
            ownerDb
              .insertInto("test_regex")
              .values(values as Insertable<TestRegexTable>)
              .execute(),
          ),
        }).toEqual({ column, error: expect.objectContaining(refusal("23502")) });
      }
    });

    it("has no row-level security: the API's role reads, creates, changes and deletes any entry with no database context", async () => {
      const { rows } = await sql<{ rls: boolean; force: boolean }>`
        select relrowsecurity as rls, relforcerowsecurity as force from pg_class where oid = to_regclass('test_regex')
      `.execute(ownerDb);
      expect(rows).toEqual([{ rls: false, force: false }]);

      const seeded = await addEntry();
      const created = await addEntry({}, db);
      expect((await db.selectFrom("test_regex").select("id").orderBy("id").execute()).map((row) => row.id)).toEqual(
        [seeded.id, created.id].sort(),
      );
      await db.updateTable("test_regex").set({ regex: "\\w+" }).where("id", "=", seeded.id).execute();
      await db.deleteFrom("test_regex").where("id", "=", created.id).execute();
      expect(await ownerDb.selectFrom("test_regex").select(["id", "regex"]).execute()).toEqual([
        { id: seeded.id, regex: "\\w+" },
      ]);
    });

    it("insertSeededTestRegexes puts the migration's 35 entries back after truncateAll, and a second call inserts nothing", async () => {
      expect(await ownerDb.selectFrom("test_regex").select("name").execute()).toEqual([]);
      await insertSeededTestRegexes(ownerDb);
      await insertSeededTestRegexes(ownerDb);
      const rows = await ownerDb.selectFrom("test_regex").select(["name", "category", "description", "regex"]).execute();
      const order = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      expect(rows.sort(order)).toEqual(migration.seededTestRegexes.map(fields).sort(order));
    });
  });
});
