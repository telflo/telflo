/**
 * An index for a version's distribution key.
 *
 *   * Migration 023's fk_configuration_versions_configuration_distribution
 *     references configurations (id, collector_distribution) and cascades.
 *     Its lookups of a configuration's versions (a hard-deleted
 *     configuration's cascade, and the check that runs when a
 *     configuration's key would change) name configuration_id and
 *     collector_distribution, and no index of configuration_versions leads
 *     with configuration_id for every row: migration 016's unique key leads
 *     with organization_id, and migration 020's index holds only the
 *     published rows. Without one, each lookup scans the table. Migrations
 *     016 and 020 index every foreign key's lookups, so this one is indexed
 *     too, with the key's own columns in its order.
 *   * Nothing else changes: no constraint, grant, policy or row.
 *
 * down drops the index. Migration 023 is left as it was committed.
 */

export const up = (pgm) => {
  pgm.sql(`
    create index idx_configuration_versions_configuration_distribution
      on configuration_versions (configuration_id, collector_distribution);

    comment on index idx_configuration_versions_configuration_distribution is
      'serves fk_configuration_versions_configuration_distribution''s lookups
       of a configuration''s versions (a hard-deleted configuration''s
       cascade, a change of the referenced key''s check), drafts and
       published versions alike; without it they would scan the table
       (migrations 016 and 020 index every foreign key''s lookups).';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop index idx_configuration_versions_configuration_distribution;
  `);
};
