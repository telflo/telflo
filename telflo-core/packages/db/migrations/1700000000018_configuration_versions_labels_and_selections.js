/**
 * Version labels, and each person's selected version (D10 decision 3).
 *
 *   * configuration_versions.label: a version's name, null or 1 to 80
 *     characters. Null shows as "Version N". The API's contract and a check
 *     enforce the 80. No row is backfilled: every existing
 *     version stays unnamed (decision 14).
 *   * configuration_versions gains unique (id, configuration_id,
 *     organization_id), which the selection's composite foreign key needs as
 *     its target. id alone is already unique; the wider key lets a selection
 *     name a version together with its configuration and organization.
 *   * configuration_version_selections: one row per person and
 *     configuration, naming the version they last opened, so /editor/{id}
 *     opens it in any browser (not localStorage).
 *     organization_id is a real column (spec §3.8). Two composite foreign
 *     keys hold it together: (configuration_id, organization_id) to the
 *     configuration, and (version_id, configuration_id, organization_id) to
 *     the version, so a selection can only name a version of its own
 *     configuration in its own organization (23503 otherwise, even for the
 *     owner). Both cascade, as does user_id: a selection goes with its
 *     configuration, its version or its person, and has no delete of its own.
 *   * selected_at has no default. The API writes it from its injected clock,
 *     never now(), as every timestamp on configurations and their versions:
 *     a write that forgets it fails (23502).
 *   * Row-level security has migration 016's shape: every operation, for
 *     telflo_platform_runtime, is limited to the organization the database context
 *     names (ADR 0022). No `force`, so the owner (migrations, fixtures) stays
 *     exempt. The policies limit a selection to its organization, not to its
 *     person: the repository filters by user_id, and no endpoint reads
 *     another person's.
 *
 * Migration 009's default privileges already give telflo_platform_runtime select,
 * insert, update and delete on the new table, and the table's existing
 * policies cover the new column, so nothing is granted here.
 *
 * down drops the table first (its foreign key depends on the new unique
 * constraint), then that constraint, then the label and its check.
 */

const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;

export const up = (pgm) => {
  pgm.sql(`
    alter table configuration_versions
      add column label text,
      add constraint ck_configuration_versions_label_length
        check (label is null or char_length(label) between 1 and 80),
      add constraint uq_configuration_versions_id_configuration_organization
        unique (id, configuration_id, organization_id);

    comment on column configuration_versions.label is
      'the version''s name (D10 decision 3): null, shown as "Version N", or 1
       to 80 characters, trimmed by the API''s contract. The starter
       configuration''s version 1 is "Initial version"; every other version 1,
       and every version before D10, is unnamed. Renaming sets only this
       column: it moves no updated_at (decision 6).';
    comment on constraint ck_configuration_versions_label_length on configuration_versions is
      'null or 1 to 80 characters (decision 3), the backstop behind the API''s
       contract: the empty string is refused, since an unnamed version stores
       null. char_length counts code points, and the contract UTF-16 units,
       which are never fewer: the contract is the stricter.';
    comment on constraint uq_configuration_versions_id_configuration_organization on configuration_versions is
      'the target of configuration_version_selections'' composite foreign key
       to a version (decision 3). id is unique on its own; this wider key is
       what lets a selection name a version together with its configuration
       and organization, so it can''t name another configuration''s version.';

    create table configuration_version_selections (
      id                uuid         primary key default uuidv7(),
      organization_id   uuid         not null,
      configuration_id  uuid         not null,
      version_id        uuid         not null,
      user_id           uuid         not null references users(id) on delete cascade,
      selected_at       timestamptz  not null,
      constraint fk_configuration_version_selections_configuration
        foreign key (configuration_id, organization_id)
        references configurations (id, organization_id) on delete cascade,
      constraint fk_configuration_version_selections_version
        foreign key (version_id, configuration_id, organization_id)
        references configuration_versions (id, configuration_id, organization_id) on delete cascade,
      constraint uq_configuration_version_selections_organization_user_config
        unique (organization_id, user_id, configuration_id)
    );

    comment on table configuration_version_selections is
      'the version each person last opened of each configuration (D10 decision
       3), so /editor/{id} opens it again, in any browser. One row per person
       and configuration, replaced on every open. Never shown to anyone but
       its person. No delete of its own: it goes with its configuration, its
       version or its person.';
    comment on column configuration_version_selections.organization_id is
      'the owning organization, the configuration''s own: a real column, as
       every organization-owned table has (spec §3.8), so the organization
       scope and the policies compare one column with no join. Both composite
       foreign keys keep it equal to the configuration''s and the version''s.';
    comment on column configuration_version_selections.configuration_id is
      'the configuration this selection is for. With organization_id, a
       foreign key to configurations (id, organization_id).';
    comment on column configuration_version_selections.version_id is
      'the version selected. With configuration_id and organization_id, a
       foreign key to configuration_versions (id, configuration_id,
       organization_id): it can only be a version of this configuration.';
    comment on column configuration_version_selections.user_id is
      'the person whose selection this is. Cascades: a hard-deleted account
       takes its selections. The policies don''t limit a row to its person;
       the repository filters by this column.';
    comment on column configuration_version_selections.selected_at is
      'when the person last opened the version, written by the API from its
       clock, never now(). No default, so a write that forgets the clock
       fails.';

    comment on constraint fk_configuration_version_selections_configuration on configuration_version_selections is
      'the composite foreign key (spec §3.8): a selection names a
       configuration and that configuration''s own organization, or the row is
       refused (23503), even for the owner. Cascades, so a hard-deleted
       configuration (or organization, through it) takes its selections.';
    comment on constraint fk_configuration_version_selections_version on configuration_version_selections is
      'a selection names a version of its own configuration in its own
       organization, or the row is refused (23503), even for the owner: the
       triple must exist in configuration_versions. Cascades with the
       version, which goes only with its configuration (decision 2).';
    comment on constraint uq_configuration_version_selections_organization_user_config on configuration_version_selections is
      'one selection per person and configuration: recording one again
       replaces it (on conflict … do update). Led by the organization, as
       §3.8''s indexes are; the repository''s find reads by it.';

    create index idx_configuration_version_selections_version
      on configuration_version_selections (version_id, configuration_id, organization_id);
    create index idx_configuration_version_selections_user_id
      on configuration_version_selections (user_id);

    comment on index idx_configuration_version_selections_version is
      'the version foreign key''s columns: deleting a version (with its
       configuration) finds the selections naming it here, not by a scan.';
    comment on index idx_configuration_version_selections_user_id is
      'a hard-deleted account cascades to its selections here; without an
       index that would scan the table (as migration 016 indexed
       created_by_user_id).';

    alter table configuration_version_selections enable row level security;

    create policy configuration_version_selections_select on configuration_version_selections
      for select to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    create policy configuration_version_selections_insert on configuration_version_selections
      for insert to telflo_platform_runtime
      with check (organization_id = ${contextOrganization});

    create policy configuration_version_selections_update on configuration_version_selections
      for update to telflo_platform_runtime
      using (organization_id = ${contextOrganization})
      with check (organization_id = ${contextOrganization});

    create policy configuration_version_selections_delete on configuration_version_selections
      for delete to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    comment on policy configuration_version_selections_select on configuration_version_selections is
      'the API''s role sees only the context''s organization''s selections, a
       deleted configuration''s included: the repository hides those, and
       other people''s. A backstop behind the organization scope.';
    comment on policy configuration_version_selections_insert on configuration_version_selections is
      'the API''s role records selections only in the context''s organization
       (42501 otherwise, before the foreign keys are checked).';
    comment on policy configuration_version_selections_update on configuration_version_selections is
      'the API''s role replaces only the context''s organization''s
       selections, and can''t move one into another organization.';
    comment on policy configuration_version_selections_delete on configuration_version_selections is
      'nothing deletes a selection on its own in D10 (it goes with its
       configuration, version or person), but a policy keeps a future delete
       inside the organization.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop table if exists configuration_version_selections;

    alter table configuration_versions
      drop constraint uq_configuration_versions_id_configuration_organization,
      drop column label;
  `);
};
