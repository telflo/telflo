/**
 * Extensions. Deliberately short: no pg_cron, pg_net or vault (spec §3.3).
 * Everything here is core contrib.
 *
 * uuidv7() needs no extension on Postgres 18 — it is built in, which is the
 * reason the spec requires 18.
 */
export const up = (pgm) => {
  pgm.createExtension("pgcrypto", { ifNotExists: true });
  pgm.createExtension("pg_trgm", { ifNotExists: true });
  pgm.createExtension("btree_gist", { ifNotExists: true });
};

export const down = (pgm) => {
  pgm.dropExtension("btree_gist", { ifExists: true });
  pgm.dropExtension("pg_trgm", { ifExists: true });
  pgm.dropExtension("pgcrypto", { ifExists: true });
};
