import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Pool } from "pg";
import { createDb, createPool } from "./pool.js";
import type { Database } from "./schema.js";

describe("database connection", () => {
  let pool: Pool;
  let db: Kysely<Database>;

  beforeAll(() => {
    const url = process.env.TELFLO_DATABASE_URL;
    if (!url) throw new Error("TELFLO_DATABASE_URL is required for integration tests");
    pool = createPool(url);
    db = createDb(pool);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("connects and answers a trivial query", async () => {
    const result = await sql<{ one: number }>`select 1 as one`.execute(db);
    expect(result.rows[0]?.one).toBe(1);
  });

  it("runs Postgres 18 or newer, which uuidv7() requires", async () => {
    // `SHOW <setting>` returns a column named after the setting itself
    // (`server_version`), not `version` — verified against a live server.
    const result = await sql<{ server_version: string }>`show server_version`.execute(db);
    const major = Number.parseInt(result.rows[0]?.server_version ?? "0", 10);
    expect(major).toBeGreaterThanOrEqual(18);
  });

  it("provides uuidv7() natively", async () => {
    const result = await sql<{ id: string }>`select uuidv7() as id`.execute(db);
    expect(result.rows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("generates uuidv7 values that sort in creation order", async () => {
    // The entire reason for choosing uuidv7 over uuidv4 (spec §3.3): index
    // locality. If generated ids did not ascend, that benefit would be absent.
    const result = await sql<{ id: string }>`
      select uuidv7() as id from generate_series(1, 50)
    `.execute(db);
    const ids = result.rows.map((r) => r.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});
