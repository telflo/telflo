/**
 * The rules the public API owns.
 *
 *   * validation_rules.is_api_owned: true for a rule written by the public
 *     API's PUT of a version's validation pipeline
 *     (`/api/public/v1/configurations/{id}/versions/{n}/validation-pipelines/{pipeline}`),
 *     false for every other (the Validation tab's, a version copy of a
 *     person's). The next PUT on that pipeline replaces only the rules
 *     marked true; a person's are kept. A column marks them (not a fixed
 *     description), so a person may
 *     rename or redescribe one without changing its owner. Every existing
 *     row is false.
 *
 * Not in the identity trigger (validation_rules_identity_unchanged,
 * migration 030): the trigger names its columns, so the new one is free to
 * change, as a rule's content is; the API never changes it after the
 * insert. No index: the PUT's delete reads one pipeline's rules, which
 * uq_validation_rules_pipeline_position already leads by. No grant or
 * policy changes: the table's existing ones cover a new column.
 *
 * down drops the column (the API's ownership marks go with it: the rules
 * stay, a person's from then on).
 */

export const up = (pgm) => {
  pgm.sql(`
    alter table validation_rules
      add column is_api_owned boolean not null default false;

    comment on column validation_rules.is_api_owned is
      'true for a rule the public API''s PUT of its validation pipeline wrote,
       which the next PUT on that pipeline replaces; false
       for a person''s (the Validation tab''s), which the PUT keeps. A version
       copy keeps it. A person''s edit of the rule doesn''t change it.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    alter table validation_rules
      drop column is_api_owned;
  `);
};
