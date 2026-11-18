/**
 * Configurations (D7 decisions 4, 6 and 8): an organization's collector
 * configurations, as the list shows them. D8 adds what the editor needs.
 *
 *   * created_at and updated_at have no default. The API writes both from its
 *     injected clock, never now(): a JavaScript Date holds milliseconds and
 *     Postgres microseconds, so a now() timestamp read back into the list's
 *     cursor wouldn't equal itself. A write that forgets the clock fails
 *     (23502) instead of quietly taking the database's time (Preflight
 *     ruling 6).
 *   * Delete is soft (decision 8): deleted_at is set, and the repository
 *     ignores the row from then on. The policies don't hide deleted rows;
 *     they are the backstop for the organization, not for deletion.
 *   * Names are not unique: two configurations may share a name.
 *   * Row-level security has migration 013's shape: every operation, for
 *     telflo_platform_runtime, is limited to the organization the database
 *     context names (ADR 0022). No `force`, so the owner (migrations,
 *     fixtures) stays exempt.
 *
 * Migration 009's default privileges already give telflo_platform_runtime select,
 * insert, update and delete on the new table, so nothing is granted here.
 *
 * down drops the table, and its constraints, indexes and policies with it.
 */

const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;

export const up = (pgm) => {
  pgm.sql(`
    create table configurations (
      id                  uuid         primary key default uuidv7(),
      organization_id     uuid         not null references organizations(id) on delete cascade,
      name                text         not null,
      description         text         not null default '',
      created_by_user_id  uuid         references users(id) on delete set null,
      created_at          timestamptz  not null,
      updated_at          timestamptz  not null,
      deleted_at          timestamptz,
      constraint ck_configurations_name_trimmed check (name = btrim(name)),
      constraint ck_configurations_name_length check (char_length(name) between 1 and 200),
      constraint ck_configurations_description_trimmed check (description = btrim(description)),
      constraint ck_configurations_description_length check (char_length(description) <= 500),
      constraint uq_configurations_id_organization_id unique (id, organization_id)
    );

    comment on table configurations is
      'an organization''s collector configurations (D7 decision 4). Every
       member sees and changes every one of them (decision 3). Deleted softly
       (decision 8): the API never removes a row.';
    comment on column configurations.organization_id is
      'the owning organization. Cascades: a hard-deleted organization takes its
       configurations with it. A soft-deleted one keeps them, unreachable,
       since the API acts only in a live organization.';
    comment on column configurations.name is
      'trimmed, 1 to 200 characters (the ck_configurations_name_* checks),
       which the API''s contract enforces first. Not unique: two
       configurations may share a name.';
    comment on column configurations.description is
      'trimmed, at most 500 characters; the empty string, not null, when there
       is none, so the list''s search and the API''s change compare it without
       a null case.';
    comment on column configurations.created_by_user_id is
      'the member who created it, or null once their account is hard-deleted
       (normally users are soft-deleted, and keep their email in the list).
       The "Mine" filter matches it (decision 6).';
    comment on column configurations.created_at is
      'written by the API from its clock, never now(), so that it holds whole
       milliseconds as a JavaScript Date does. No default, so a write that
       forgets the clock fails.';
    comment on column configurations.updated_at is
      'written by the API from its clock on create and on every change and
       delete, never now(). The list is ordered by it and pages by it, so it
       must read back equal to the cursor''s JavaScript Date: whole
       milliseconds. No default, so a write that forgets the clock fails.';
    comment on column configurations.deleted_at is
      'set when a member deletes the configuration (decision 8). The row stays;
       every read and write through the repository ignores it from then on.
       Nothing restores one yet.';

    comment on constraint uq_configurations_id_organization_id on configurations is
      'the composite foreign-key target (spec §3.8) that D8''s and D10''s child
       tables reference with their own organization_id, so a child row can
       never name a configuration in another organization. id alone is
       already unique.';

    create index idx_configurations_organization_id_updated_at
      on configurations (organization_id, updated_at desc, id desc)
      where deleted_at is null;
    create index idx_configurations_created_by_user_id
      on configurations (created_by_user_id);

    comment on index idx_configurations_organization_id_updated_at is
      'the list (decision 6): an organization''s live configurations, newest
       change first, id breaking ties, so a page continues after its cursor''s
       (updated_at, id) pair with a row comparison. Deleted rows fall out of
       it: nothing lists them.';
    comment on index idx_configurations_created_by_user_id is
      'a hard-deleted account sets created_by_user_id to null here; without an
       index that would scan the table.';

    alter table configurations enable row level security;

    create policy configurations_select on configurations
      for select to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    create policy configurations_insert on configurations
      for insert to telflo_platform_runtime
      with check (organization_id = ${contextOrganization});

    create policy configurations_update on configurations
      for update to telflo_platform_runtime
      using (organization_id = ${contextOrganization})
      with check (organization_id = ${contextOrganization});

    create policy configurations_delete on configurations
      for delete to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    comment on policy configurations_select on configurations is
      'the API''s role sees only the context''s organization''s
       configurations, deleted ones included: the repository hides those. A
       backstop behind the organization scope.';
    comment on policy configurations_insert on configurations is
      'the API''s role creates configurations only in the context''s
       organization (42501 otherwise).';
    comment on policy configurations_update on configurations is
      'the API''s role changes only the context''s organization''s
       configurations, and can''t move one into another organization. A
       locking read (the repository''s for update) is held to it as well.';
    comment on policy configurations_delete on configurations is
      'nothing deletes a configuration (deleting sets deleted_at), but a
       policy keeps a future delete inside the organization.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop table if exists configurations;
  `);
};
