/**
 * Configuration versions: a configuration's content, its YAML, the editor
 * opens and saves. This migration writes only version 1; later ones build
 * versions on this table.
 *
 *   * organization_id is a real column, and the composite foreign
 *     key to configurations (id, organization_id) makes it impossible for a
 *     version to name a configuration in another organization: the pair must
 *     exist, so the two columns can't drift apart. It cascades, so a
 *     hard-deleted configuration, or organization, takes its versions with it.
 *   * There is no deleted_at. A version is reachable only through a live
 *     configuration: the repository joins its configuration on both columns
 *     and skips a deleted one.
 *   * yaml_content, created_at and updated_at have no default. The API writes
 *     the timestamps from its injected clock, never now() (as migration 015's
 *     do), and the YAML always: a write that forgets one fails (23502)
 *     instead of quietly storing the database's time or no content.
 *   * Row-level security has migration 015's shape: every operation, for
 *     telflo_platform_runtime, is limited to the organization the database context
 *     names. No `force`, so the owner (migrations, fixtures, this
 *     backfill) stays exempt.
 *   * Then every existing configuration, deleted or not, gets its version 1:
 *     empty YAML, created by the configuration's creator at its created_at.
 *     So from here on every configuration has content, and the editor never
 *     meets one without. A migration has no API clock, so both timestamps are
 *     the configuration's created_at, which the API wrote from its clock and
 *     so holds whole milliseconds already. No account gets a starter
 *     configuration here: only new accounts do.
 *
 * Migration 009's default privileges already give telflo_platform_runtime select,
 * insert, update and delete on the new table, so nothing is granted here.
 *
 * down drops the table, and its constraints, indexes, policies and the
 * backfilled rows with it.
 */

const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;

export const up = (pgm) => {
  pgm.sql(`
    create table configuration_versions (
      id                  uuid         primary key default uuidv7(),
      configuration_id    uuid         not null,
      organization_id     uuid         not null,
      version_number      integer      not null,
      yaml_content        text         not null,
      created_by_user_id  uuid         references users(id) on delete set null,
      created_at          timestamptz  not null,
      updated_at          timestamptz  not null,
      constraint fk_configuration_versions_configuration
        foreign key (configuration_id, organization_id)
        references configurations (id, organization_id) on delete cascade,
      constraint uq_configuration_versions_organization_configuration_version
        unique (organization_id, configuration_id, version_number),
      constraint ck_configuration_versions_version_number check (version_number >= 1),
      constraint ck_configuration_versions_yaml_content_length check (char_length(yaml_content) <= 262144)
    );

    comment on table configuration_versions is
      'a configuration''s content: its YAML, by version. No deleted_at: a
       version is reachable only through a live configuration, and goes with
       it when the configuration''s row is removed.';
    comment on column configuration_versions.configuration_id is
      'the configuration this is a version of. With organization_id, a
       foreign key to configurations (id, organization_id).';
    comment on column configuration_versions.organization_id is
      'the owning organization, the configuration''s own: a real column, as
       every organization-owned table has, so the organization
       scope and the policies compare one column with no join. The composite
       foreign key keeps it equal to the configuration''s.';
    comment on column configuration_versions.version_number is
      'the version''s number within its configuration, from 1. The editor
       opens the highest.';
    comment on column configuration_versions.yaml_content is
      'the configuration''s YAML, exactly as the editor sent it, the empty
       string included: nothing trims or normalizes it. At most 262,144
       characters, which the API''s contract enforces first. It
       is private: never logged, audited or sent to analytics. No default, so
       a write that forgets it fails.';
    comment on column configuration_versions.created_by_user_id is
      'the member who created the version, or null once their account is
       hard-deleted (normally users are soft-deleted). For a version the
       migration backfilled, the configuration''s creator.';
    comment on column configuration_versions.created_at is
      'written by the API from its clock, never now(), so that it holds whole
       milliseconds as a JavaScript Date does. No default, so a write that
       forgets the clock fails. For a backfilled version, the configuration''s
       created_at.';
    comment on column configuration_versions.updated_at is
      'written by the API from its clock on create and on every save, never
       now(). No default, so a write that forgets the clock fails. For a
       backfilled version, the configuration''s created_at.';

    comment on constraint fk_configuration_versions_configuration on configuration_versions is
      'the composite foreign key: a version names a configuration
       and that configuration''s own organization, or the pair doesn''t exist
       and the row is refused (23503), even for the owner. Cascades, so a
       hard-deleted configuration (or organization, through it) takes its
       versions.';
    comment on constraint uq_configuration_versions_organization_configuration_version on configuration_versions is
      'one row per version number within a configuration. Led by the
       organization, and its index also serves the composite foreign key''s
       lookups of a configuration''s versions (a cascade, a delete''s check),
       so no other index is needed for them.';
    comment on constraint ck_configuration_versions_version_number on configuration_versions is
      'versions are numbered from 1.';
    comment on constraint ck_configuration_versions_yaml_content_length on configuration_versions is
      'the 262,144-character limit, as the backstop behind the API''s
       contract. char_length counts code points, and the contract UTF-16
       units, which are never fewer: the contract is the stricter.';

    create index idx_configuration_versions_created_by_user_id
      on configuration_versions (created_by_user_id);

    comment on index idx_configuration_versions_created_by_user_id is
      'a hard-deleted account sets created_by_user_id to null here; without an
       index that would scan the table.';

    alter table configuration_versions enable row level security;

    create policy configuration_versions_select on configuration_versions
      for select to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    create policy configuration_versions_insert on configuration_versions
      for insert to telflo_platform_runtime
      with check (organization_id = ${contextOrganization});

    create policy configuration_versions_update on configuration_versions
      for update to telflo_platform_runtime
      using (organization_id = ${contextOrganization})
      with check (organization_id = ${contextOrganization});

    create policy configuration_versions_delete on configuration_versions
      for delete to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    comment on policy configuration_versions_select on configuration_versions is
      'the API''s role sees only the context''s organization''s versions, a
       deleted configuration''s included: the repository hides those. A
       backstop behind the organization scope.';
    comment on policy configuration_versions_insert on configuration_versions is
      'the API''s role creates versions only in the context''s organization
       (42501 otherwise, before the foreign key is checked).';
    comment on policy configuration_versions_update on configuration_versions is
      'the API''s role saves only the context''s organization''s versions, and
       can''t move one into another organization.';
    comment on policy configuration_versions_delete on configuration_versions is
      'nothing deletes a version on its own (it goes with its
       configuration), but a policy keeps a future delete inside the
       organization.';

    insert into configuration_versions
      (configuration_id, organization_id, version_number, yaml_content, created_by_user_id, created_at, updated_at)
    select id, organization_id, 1, '', created_by_user_id, created_at, created_at
      from configurations;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop table if exists configuration_versions;
  `);
};
