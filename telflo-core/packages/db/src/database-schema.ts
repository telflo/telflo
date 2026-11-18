/**
 * The schema that holds every object of the platform's database: its tables,
 * functions, extensions and node-pg-migrate's `pgmigrations`. It is never
 * `public`, which stays empty (the opamp-server keeps its own objects in
 * `opamp_server` the same way). The migration role (the tables' owner)
 * creates it on the first migration.
 */
export const PLATFORM_SCHEMA = "platform";

/**
 * node-postgres's `options` for every connection to the platform's database:
 * unqualified names resolve in PLATFORM_SCHEMA. The migrations also set it as
 * the database's own default (`alter database … set search_path`), for a
 * psql session or a tool that connects without these options.
 */
export const PLATFORM_CONNECTION_OPTIONS = `-c search_path=${PLATFORM_SCHEMA}`;

/**
 * node-pg-migrate's runner options for the platform's migrations, the same
 * for `migrateToLatest` and a test's throwaway database: the objects and
 * `pgmigrations` in PLATFORM_SCHEMA, created on the first run.
 */
export const PLATFORM_MIGRATION_OPTIONS = {
  migrationsTable: "pgmigrations",
  schema: PLATFORM_SCHEMA,
  createSchema: true,
  migrationsSchema: PLATFORM_SCHEMA,
} as const;
