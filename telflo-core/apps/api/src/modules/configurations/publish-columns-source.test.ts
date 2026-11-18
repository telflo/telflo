import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * D11b decision 9 and Preflight ruling 8: a version is published only by
 * the publish's record, `recordPublish` in the version repository, whose
 * one statement writes the three publish columns only for a draft still
 * holding the YAML the opamp-server took. Row-level security lets the
 * API's role update a draft it can see (Task 2's review): so any other
 * write of those columns in the API's code could publish text no snapshot
 * holds. This scan keeps `recordPublish` the only writer, in the style of
 * database/context-source.test.ts.
 */

/** apps/api/src: the API's source. */
const apiSourceRoot = fileURLToPath(new URL("../../", import.meta.url));

const isSource = (path: string) => /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(path);
const isTest = (path: string) => /\.test\.[jt]sx?$/.test(path);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return isSource(entry.name) ? [path] : [];
  });
}

/** Every source file under apps/api/src, relative to it, with `/` separators. */
const apiSources = () => sourceFiles(apiSourceRoot).map((path) => relative(apiSourceRoot, path).split(sep).join("/"));

const productionSources = () => apiSources().filter((path) => !isTest(path));

const read = (path: string) => readFileSync(join(apiSourceRoot, path), "utf8");

const VERSION_REPOSITORY = "modules/configurations/repositories/configuration-version-repository.ts";

/**
 * The cross-tenant suite's registry (D5 decision 5): test support, which
 * seeds a published version as the tables' owner, past row-level security,
 * as packages/db's fixtures do. Not the API's code: only test files import
 * it, which a test below checks.
 */
const OWNER_SEEDS = "tenancy/resource-registry.ts";

const PUBLISH_COLUMNS = ["published_at", "publication_id", "published_by_user_id"] as const;

/**
 * A write of a publish column: an object key or a shorthand property (what
 * Kysely's `set`, `updateTable` and `insertInto` take), Kysely's
 * `set("column", value)`, or an SQL assignment (`set column = …`, also a
 * comparison, which an SQL read of these columns doesn't need here). A read
 * names the column as a qualified string ("configuration_versions.…"), a
 * type's union member or a row's property, none of which match.
 */
function writesOf(source: string): string[] {
  const column = `(?:${PUBLISH_COLUMNS.join("|")})`;
  const patterns = [
    // `published_at: value`, `"published_at": value`, or `{ published_at }` / `{ published_at, … }`.
    new RegExp(`(?<![\\w.$"'])["']?${column}["']?\\s*(?::(?!:)|,|\\})`, "g"),
    // Kysely's `.set("published_at", value)`.
    new RegExp(`\\.set\\(\\s*["'](?:\\w+\\.)?${column}["']`, "g"),
    // SQL: `published_at = …`.
    new RegExp(`(?<![\\w.$"'])${column}\\s*=(?!=)`, "g"),
  ];
  return patterns.flatMap((pattern) => source.match(pattern) ?? []);
}

/** The text of `recordPublish`'s body in the version repository: from its name to its closing brace. */
function recordPublishBody(source: string): { body: string; rest: string } {
  const start = source.indexOf("async recordPublish(");
  if (start === -1) throw new Error("the version repository has no recordPublish method");
  const open = source.indexOf("{", source.indexOf(")", source.indexOf("): Promise<", start)));
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) {
      return { body: source.slice(start, index + 1), rest: source.slice(0, start) + source.slice(index + 1) };
    }
  }
  throw new Error("recordPublish's body has no end");
}

describe("the publish columns' only writer (D11b decision 9, Preflight ruling 8)", () => {
  it("finds writes, and only writes, of the columns", () => {
    const writes = [
      `.updateTable("configuration_versions", { published_at: at })`,
      `{ publication_id: id, other: 1 }`,
      `{ "published_by_user_id": userId }`,
      `.set({ published_at })`,
      `.set({ published_at, publication_id })`,
      `.set("published_at", at)`,
      `.set("configuration_versions.publication_id", id)`,
      "sql`update configuration_versions set published_by_user_id = ${userId}`",
    ];
    for (const write of writes) expect(writesOf(write), write).not.toEqual([]);
    const reads = [
      `"configuration_versions.published_at",`,
      `.where("configuration_versions.published_at", "is", null)`,
      `| "published_at"`,
      `publishedAt: row.published_at,`,
      `row.published_by_user_id !== null`,
      `.leftJoin("users as publishers", "publishers.id", "written.published_by_user_id")`,
      `"written.publication_id",`,
    ];
    for (const read of reads) expect(writesOf(read), read).toEqual([]);
  });

  it("scans real source: recordPublish writes all three columns", () => {
    expect(productionSources()).toContain(VERSION_REPOSITORY);
    const { body } = recordPublishBody(read(VERSION_REPOSITORY));
    for (const column of PUBLISH_COLUMNS) {
      expect(
        writesOf(body).some((write) => write.includes(column)),
        column,
      ).toBe(true);
    }
  });

  it("writes them nowhere else in the API's code", () => {
    const offenders = productionSources()
      .filter((path) => path !== OWNER_SEEDS)
      .flatMap((path) => {
        const source = path === VERSION_REPOSITORY ? recordPublishBody(read(path)).rest : read(path);
        return writesOf(source).map((write) => `${path}: ${write}`);
      });
    expect(offenders).toEqual([]);
  });

  it("leaves the owner's seeds to test files: only a test imports the registry", () => {
    const importers = apiSources().filter(
      (path) => path !== OWNER_SEEDS && /resource-registry\.js["']/.test(read(path)),
    );
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((path) => !isTest(path))).toEqual([]);
  });
});
