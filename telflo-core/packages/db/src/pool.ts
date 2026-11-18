import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { PLATFORM_CONNECTION_OPTIONS } from "./database-schema.js";
import type { Database } from "./schema.js";

const { Pool, types } = pg;

// node-postgres parses int8 (bigint) to string by default to avoid precision
// loss. Every bigint we use is a count that fits in a JS number comfortably,
// and silently receiving strings where numbers are expected is a reliable
// source of bugs, so parse them as numbers.
types.setTypeParser(types.builtins.INT8, (value: string) => Number.parseInt(value, 10));

// A `date` (collector_versions.released_at, D13a) is a calendar day, not an
// instant: node-postgres would make it a Date at local midnight, which
// shifts to the previous day in any timezone west of UTC once it is
// serialized. Read it as its `YYYY-MM-DD` text instead.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

export function createPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    // Unqualified names resolve in the platform schema, never public.
    options: PLATFORM_CONNECTION_OPTIONS,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
