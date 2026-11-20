/**
 * The collector's renames, per distribution.
 *
 *   * collector_distributions.renamed_types: the catalogue file's
 *     `renamedTypes`, as the file holds it, in its order:
 *     [{ "kind", "name", "deprecatedName", "since" }, …]. The migration
 *     step's sync writes it with the rest of the row; the catalogue's
 *     validator checks every entry first, so the database checks only that
 *     it is a list. `GET /api/v1/collector-distributions` serves it.
 *   * Not null, default '[]': every existing row (the Contrib row migration
 *     023 inserts, and any fixture distribution a test inserts without it)
 *     has no renames until the sync writes the file's, and the sync then
 *     writes the list in the same run.
 *   * Nothing else changes: no grant (the API's role still only reads the
 *     table), no policy, no other column.
 *
 * down drops the column and its check. The sync of an older checkout
 * doesn't name it.
 */

export const up = (pgm) => {
  pgm.sql(`
    alter table collector_distributions
      add column renamed_types jsonb not null default '[]',
      add constraint ck_collector_distributions_renamed_types_array
        check (jsonb_typeof(renamed_types) = 'array');

    comment on column collector_distributions.renamed_types is
      'the collector''s renames: the catalogue file''s
       renamedTypes, in its order, [{ "kind", "name", "deprecatedName",
       "since" }, …]: from upstream''s version since on, the kind of
       component deprecatedName is called name. Kind-specific; written by
       the sync after the catalogue''s validator checked every entry; []
       when there are none.';
    comment on constraint ck_collector_distributions_renamed_types_array on collector_distributions is
      'renamed_types is a list, as a backstop behind the catalogue''s
       validator, which checks each entry.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    alter table collector_distributions
      drop constraint ck_collector_distributions_renamed_types_array,
      drop column renamed_types;
  `);
};
