/**
 * Test suites, their definitions, the definitions' inputs and test templates.
 *
 *   * test_suites: a configuration version's named groups of test
 *     configurations. A composite foreign key ties a suite to its version in
 *     its own configuration and organization, on delete cascade. Row-level
 *     security is migration 021's child-visible rule for select, update and
 *     delete (a draft's suites are its author's, a published configuration's
 *     every member's, who may create, rename and delete them); an insert also
 *     names the context's user as its creator. A trigger,
 *     test_suites_identity_unchanged, keeps a suite's id, organization,
 *     configuration, version and created_at, and lets its creator change only
 *     to null (the users foreign key's on delete set null), as migration 022's
 *     configurations_author_unchanged.
 *   * test_definition_inputs: the inputs definitions run, each a copy made
 *     when a definition is created, its bytes in the FileStore at
 *     organizations/<org>/test-definition-inputs/<id>. An input carries its
 *     configuration: a version copy shares its inputs, and never leaves its
 *     configuration, so the child-visible rule applies to select, insert and
 *     delete, and a draft's file names stay its author's. No update.
 *   * test_definitions: a suite's test configurations: a name, a description,
 *     an input, a pipeline and its signal, a duration of 1 to 60 seconds.
 *     Created and deleted, never changed. Composite foreign keys tie a
 *     definition to a suite of its own version (on delete cascade) and to an
 *     input of its own configuration: NO ACTION, DEFERRABLE INITIALLY
 *     DEFERRED, so a configuration's hard delete, whose cascades reach the
 *     inputs before the definitions, still works, and removing an input a
 *     definition still uses is refused at commit. Row-level security: the
 *     child-visible rule for select and delete, and for an insert naming the
 *     context's user as creator (so no member can forge it); no update.
 *   * The reference count: an input is in use while a definition names it.
 *     Every path that adds or removes a reference holds the configuration's
 *     row lock (FOR UPDATE), so "no definition names it" can't change under a
 *     delete; the deferred key is the backstop when a path forgets the lock.
 *     No column, no function.
 *   * test_templates: product-wide sample inputs: global, with no organization
 *     and no row-level security, as flows. Members read the live ones and
 *     product admins write them, which the API decides. Deletes are soft:
 *     DELETE is revoked from telflo_platform_runtime. A trigger,
 *     test_templates_guard, keeps a template's id, created_at and file
 *     columns, its creator but to null, and lets deleted_at go only from null
 *     to a time.
 *   * test_runs gains the "Suite › Configuration" breadcrumb: test_suite_id,
 *     test_suite_name, test_definition_id and test_definition_name, all four
 *     set or none. The ids have no foreign key, as source_run_id. A run from a
 *     template records nothing here: its input_name is the template's file
 *     name, and the audit row names the template. refuse_test_run_change() is
 *     replaced to keep the four in the snapshot.
 *   * test_runs_waiting_for_context_user() is replaced to count the
 *     context's organization only (the cap of 50 is per person, per
 *     organization).
 *
 * Migration 009's default privileges give telflo_platform_runtime select,
 * insert, update and delete on the four tables; test_templates' delete is
 * revoked.
 *
 * down restores migration 028's refuse_test_run_change() and
 * test_runs_waiting_for_context_user() byte for byte, with their comments,
 * drops the four columns of test_runs with their checks and index, and
 * drops the four tables and the two trigger functions: exactly what up
 * added.
 */

const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;
const contextUser = `nullif(current_setting('telflo.user_id', true), '')::uuid`;

/** Migration 021's: a child row of `table` whose configuration the context may see. */
const childVisible = (table) => `organization_id = ${contextOrganization}
        and exists (select 1 from configurations c
                     where c.id = ${table}.configuration_id
                       and c.organization_id = ${table}.organization_id)`;

/** Migration 028's snapshot columns: the run's identity and what it ran. */
const snapshotColumns028 = [
  "id",
  "organization_id",
  "configuration_id",
  "configuration_version_id",
  "source_run_id",
  "yaml",
  "target_pipeline",
  "signal",
  "duration_seconds",
  "collector_distribution",
  "collector_version",
  "input_name",
  "input_size_bytes",
  "queued_at",
];

/** The breadcrumb's columns, in the snapshot too. */
const breadcrumbColumns = ["test_suite_id", "test_suite_name", "test_definition_id", "test_definition_name"];

/**
 * Migration 028's refuse_test_run_change(), over `columns`, laid out as 028
 * lays it out: with 028's columns, its source is 028's byte for byte, which
 * schema.integration.test.ts checks (md5 of prosrc).
 */
const runGuard = (columns) => `
    create or replace function refuse_test_run_change() returns trigger
    language plpgsql
    set search_path = pg_catalog, platform
    as $$
    declare
      kept platform.test_runs;
    begin
      if (${columns.map((column) => `new.${column}`).join(", ")})
           is distinct from
         (${columns.map((column) => `old.${column}`).join(", ")})
         or (new.queued_by_user_id is distinct from old.queued_by_user_id
             and new.queued_by_user_id is not null)
      then
        raise exception 'test run % keeps its snapshot', old.id;
      end if;
      if new.status = old.status then
        kept := new;
        kept.queued_by_user_id := old.queued_by_user_id;
        if kept is distinct from old then
          raise exception 'test run % changes only with its status', old.id;
        end if;
        return new;
      end if;
      if not ((old.status = 'queued' and new.status in ('running', 'failed'))
              or (old.status = 'running' and new.status in ('succeeded', 'failed', 'queued')))
      then
        raise exception 'test run % can''t go from % to %', old.id, old.status, new.status;
      end if;
      return new;
    end;
    $$;
`;

/** Migration 028's test_runs_waiting_for_context_user(), laid out as 028 lays it out, with `extra` conditions. */
const waitingForContextUser = (extra) => `
    create or replace function test_runs_waiting_for_context_user()
    returns integer
    language sql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
      select count(*)::integer
        from platform.test_runs r
       where r.status = 'queued'
         and r.queued_by_user_id = ${contextUser}${extra}
    $$;
`;

export const up = (pgm) => {
  pgm.sql(`
    create table test_suites (
      id                        uuid         primary key default uuidv7(),
      organization_id           uuid         not null references organizations(id) on delete cascade,
      configuration_id          uuid         not null,
      configuration_version_id  uuid         not null,
      name                      text         not null,
      description               text         not null default '',
      created_by_user_id        uuid         references users(id) on delete set null,
      created_at                timestamptz  not null,
      updated_at                timestamptz  not null,
      constraint fk_test_suites_configuration_version
        foreign key (configuration_version_id, configuration_id, organization_id)
        references configuration_versions (id, configuration_id, organization_id) on delete cascade,
      constraint uq_test_suites_id_version_configuration_organization
        unique (id, configuration_version_id, configuration_id, organization_id),
      constraint ck_test_suites_name_trimmed check (name = btrim(name)),
      constraint ck_test_suites_name_length check (char_length(name) between 1 and 200),
      constraint ck_test_suites_description_length check (char_length(description) <= 2000)
    );

    comment on table test_suites is
      'a configuration version''s test suites, each a named
       group of test configurations (test_definitions). Visible to whoever can
       see its configuration: a draft''s are its author''s, a published
       configuration''s every member''s, who may create, rename, describe and
       delete them on any version, published or not. A new version copies
       its source''s suites.';
    comment on column test_suites.id is
      'the suite''s id (uuidv7). A version copy takes a new one per suite, in
       the source''s order, so (created_at, id) keeps that order.';
    comment on column test_suites.organization_id is
      'the configuration''s organization (fk_test_suites_configuration_version).
       A hard-deleted organization takes its suites.';
    comment on column test_suites.configuration_id is
      'the configuration whose visibility the suite follows.';
    comment on column test_suites.configuration_version_id is
      'the version the suite belongs to (fk_test_suites_configuration_version).
       Never changed (test_suites_identity_unchanged).';
    comment on column test_suites.name is
      'trimmed, 1 to 200 characters; not unique. Configuration text:
       never in a log line, an attribute, an audit row or a URL.';
    comment on column test_suites.description is
      'at most 2,000 characters; the empty string when there is none.
       Configuration text, as the name.';
    comment on column test_suites.created_by_user_id is
      'the member who created it, or who created the version whose copy it
       is: the insert policy admits only the context''s user.
       Null once their account is hard-deleted; never changed otherwise.';
    comment on column test_suites.created_at is
      'written by the API from its clock, never now(), as configurations''
       (migration 015''s rule); a version copy writes the version''s time. The
       list''s order, with the id.';
    comment on column test_suites.updated_at is
      'written by the API from its clock on create and on every rename or
       new description.';

    comment on constraint test_suites_pkey on test_suites is
      'one row per suite, by its id.';
    comment on constraint test_suites_organization_id_fkey on test_suites is
      'the suite''s organization (23503 otherwise); on delete cascade.';
    comment on constraint test_suites_created_by_user_id_fkey on test_suites is
      'the suite''s creator (23503 otherwise); on delete set null, which the
       identity trigger allows.';
    comment on constraint fk_test_suites_configuration_version on test_suites is
      'a suite names a version of its own configuration in its own
       organization (23503 otherwise). On delete cascade: a version goes only
       with its configuration, which the API never hard-deletes (migration
       022), so only an operator''s or an organization''s hard delete reaches
       it.';
    comment on constraint uq_test_suites_id_version_configuration_organization on test_suites is
      'the target of fk_test_definitions_suite: a definition names a suite of
       its own version, configuration and organization.';
    comment on constraint ck_test_suites_name_trimmed on test_suites is
      'the name is trimmed, which the API''s contract does first.';
    comment on constraint ck_test_suites_name_length on test_suites is
      'the name is 1 to 200 characters.';
    comment on constraint ck_test_suites_description_length on test_suites is
      'the description is at most 2,000 characters.';

    create index idx_test_suites_version_created_at
      on test_suites (configuration_version_id, created_at, id);
    create index idx_test_suites_organization_configuration
      on test_suites (organization_id, configuration_id);
    create index idx_test_suites_created_by_user_id
      on test_suites (created_by_user_id);

    comment on index idx_test_suites_version_created_at is
      'a version''s suites in their order (created_at, id): the list and the
       version copy. Led by the version, it also serves
       fk_test_suites_configuration_version''s cascade.';
    comment on index idx_test_suites_organization_configuration is
      'a configuration''s suites, and an organization''s cascade.';
    comment on index idx_test_suites_created_by_user_id is
      'a hard-deleted account''s set null; without an index that would scan
       the table.';

    alter table test_suites enable row level security;

    create policy test_suites_select on test_suites
      for select to telflo_platform_runtime
      using (${childVisible("test_suites")});
    create policy test_suites_insert on test_suites
      for insert to telflo_platform_runtime
      with check (${childVisible("test_suites")}
        and created_by_user_id = ${contextUser});
    create policy test_suites_update on test_suites
      for update to telflo_platform_runtime
      using (${childVisible("test_suites")})
      with check (${childVisible("test_suites")});
    create policy test_suites_delete on test_suites
      for delete to telflo_platform_runtime
      using (${childVisible("test_suites")});

    comment on policy test_suites_select on test_suites is
      'the API''s role sees the suites of the configurations the context''s
       user can see (configurations_select applies inside the exists): a
       draft''s are its author''s, a published configuration''s every
       member''s.';
    comment on policy test_suites_insert on test_suites is
      'the API''s role adds a suite only to a configuration the context''s
       user can see, as that user (42501 otherwise).';
    comment on policy test_suites_update on test_suites is
      'the API''s role renames and describes only the suites it can see,
       on any version, and keeps them visible.';
    comment on policy test_suites_delete on test_suites is
      'the API''s role deletes only the suites it can see; their definitions
       go with them (fk_test_definitions_suite).';

    -- Not SECURITY DEFINER: it reads only the row it is given, as whatever
    -- role runs the update. P0001 (raise_exception), as migration 022's
    -- trigger raises, with a message naming only the suite's id.
    create function refuse_test_suite_identity_change() returns trigger
    language plpgsql
    set search_path = pg_catalog, platform
    as $$
    begin
      if (new.id, new.organization_id, new.configuration_id, new.configuration_version_id, new.created_at)
           is distinct from
         (old.id, old.organization_id, old.configuration_id, old.configuration_version_id, old.created_at)
         or (new.created_by_user_id is distinct from old.created_by_user_id
             and new.created_by_user_id is not null)
      then
        raise exception 'test suite % keeps its version and its creator', old.id;
      end if;
      return new;
    end;
    $$;

    create trigger test_suites_identity_unchanged
      before update on test_suites
      for each row execute function refuse_test_suite_identity_change();

    comment on function refuse_test_suite_identity_change() is
      'a suite keeps its identity, kept by the
       database for every role: its id, organization, configuration, version
       and created_at never change, and its creator only to null (the users
       foreign key''s on delete set null), as migration 022''s
       refuse_configuration_author_change. P0001, naming only the suite''s
       id. A same-value write passes. Not SECURITY DEFINER: it reads only the
       row it is given.';
    comment on trigger test_suites_identity_unchanged on test_suites is
      'before update, for every role on a plain UPDATE, the API''s and the
       tables'' owner alike. Only an operator can bypass it (ALTER TABLE …
       DISABLE TRIGGER, session_replication_role = replica).';

    create table test_definition_inputs (
      id                uuid         primary key default uuidv7(),
      organization_id   uuid         not null references organizations(id) on delete cascade,
      configuration_id  uuid         not null,
      file_name         text         not null,
      content_type      text         not null,
      size_bytes        integer      not null,
      sha256            bytea        not null,
      created_at        timestamptz  not null default now(),
      constraint fk_test_definition_inputs_configuration
        foreign key (configuration_id, organization_id)
        references configurations (id, organization_id) on delete cascade,
      constraint uq_test_definition_inputs_id_configuration_organization
        unique (id, configuration_id, organization_id),
      constraint ck_test_definition_inputs_file_name_length check (char_length(file_name) between 1 and 255),
      constraint ck_test_definition_inputs_content_type_present
        check (btrim(content_type) <> '' and char_length(content_type) <= 255),
      constraint ck_test_definition_inputs_size_bytes check (size_bytes between 0 and 10485760),
      constraint ck_test_definition_inputs_sha256_length check (octet_length(sha256) = 32)
    );

    comment on table test_definition_inputs is
      'the inputs test definitions run: each a copy
       of a test file or a template, made when a definition is created, its
       bytes in the FileStore at organizations/<org>/test-definition-inputs/<id>.
       A version copy''s definitions share their source''s inputs; an input
       is removed, row then bytes, once no definition names it, under the
       configuration''s row lock. Visible to whoever can
       see its configuration. Never changed.';
    comment on column test_definition_inputs.id is
      'the input''s id, which names its bytes in the FileStore.';
    comment on column test_definition_inputs.organization_id is
      'the configuration''s organization. A hard-deleted organization takes
       its inputs'' rows (their bytes stay on disk until they are pruned).';
    comment on column test_definition_inputs.configuration_id is
      'the configuration whose definitions use it: an
       input is shared only within its configuration, so its visibility
       follows it, and the configuration''s lock serializes its reference
       count.';
    comment on column test_definition_inputs.file_name is
      'the original file''s name with its extension, 1 to 255 characters; a
       run''s input_name copies it. Configuration text: never in a
       log line, an attribute, an audit row or a URL.';
    comment on column test_definition_inputs.content_type is
      'from the name''s last extension, never the
       browser''s MIME type or a sniff.';
    comment on column test_definition_inputs.size_bytes is
      'the copy''s size, at most 10,485,760 bytes.';
    comment on column test_definition_inputs.sha256 is
      'the copy''s SHA-256, 32 bytes, as the FileStore computed it while
       writing it.';
    comment on column test_definition_inputs.created_at is
      'when the row was inserted, by the database''s clock.';

    comment on constraint test_definition_inputs_pkey on test_definition_inputs is
      'one row per input, by its id.';
    comment on constraint test_definition_inputs_organization_id_fkey on test_definition_inputs is
      'the input''s organization (23503 otherwise); on delete cascade.';
    comment on constraint fk_test_definition_inputs_configuration on test_definition_inputs is
      'an input names a configuration of its own organization (23503
       otherwise). On delete cascade: only an operator''s or an
       organization''s hard delete reaches it (migration 022).';
    comment on constraint uq_test_definition_inputs_id_configuration_organization on test_definition_inputs is
      'the target of fk_test_definitions_input: a definition names an input
       of its own configuration and organization.';
    comment on constraint ck_test_definition_inputs_file_name_length on test_definition_inputs is
      'the file''s name is 1 to 255 characters, as a test file''s.';
    comment on constraint ck_test_definition_inputs_content_type_present on test_definition_inputs is
      'a content type is named, at most 255 characters.';
    comment on constraint ck_test_definition_inputs_size_bytes on test_definition_inputs is
      'an input is at most 10 MiB, as an upload.';
    comment on constraint ck_test_definition_inputs_sha256_length on test_definition_inputs is
      'a SHA-256 is 32 bytes.';

    create index idx_test_definition_inputs_organization_configuration
      on test_definition_inputs (organization_id, configuration_id);

    comment on index idx_test_definition_inputs_organization_configuration is
      'fk_test_definition_inputs_configuration''s lookups of a
       configuration''s inputs, and an organization''s cascade.';

    alter table test_definition_inputs enable row level security;

    create policy test_definition_inputs_select on test_definition_inputs
      for select to telflo_platform_runtime
      using (${childVisible("test_definition_inputs")});
    create policy test_definition_inputs_insert on test_definition_inputs
      for insert to telflo_platform_runtime
      with check (${childVisible("test_definition_inputs")});
    create policy test_definition_inputs_update on test_definition_inputs
      for update to telflo_platform_runtime
      using (false);
    create policy test_definition_inputs_delete on test_definition_inputs
      for delete to telflo_platform_runtime
      using (${childVisible("test_definition_inputs")});

    comment on policy test_definition_inputs_select on test_definition_inputs is
      'the API''s role sees the inputs of the configurations the context''s
       user can see: a draft''s file names stay its
       author''s.';
    comment on policy test_definition_inputs_insert on test_definition_inputs is
      'the API''s role adds an input only to a configuration the context''s
       user can see (42501 otherwise).';
    comment on policy test_definition_inputs_update on test_definition_inputs is
      'an input never changes: the API''s role updates none, and so locks
       none with FOR UPDATE (the reference count holds the configuration''s
       lock instead).';
    comment on policy test_definition_inputs_delete on test_definition_inputs is
      'the API''s role deletes only the inputs it can see; one a definition
       still names is refused at commit (fk_test_definitions_input).';

    create table test_definitions (
      id                        uuid         primary key default uuidv7(),
      organization_id           uuid         not null references organizations(id) on delete cascade,
      configuration_id          uuid         not null,
      configuration_version_id  uuid         not null,
      test_suite_id             uuid         not null,
      input_id                  uuid         not null,
      name                      text         not null,
      description               text         not null default '',
      target_pipeline           text         not null,
      signal                    text         not null,
      duration_seconds          smallint     not null,
      created_by_user_id        uuid         references users(id) on delete set null,
      created_at                timestamptz  not null,
      constraint fk_test_definitions_suite
        foreign key (test_suite_id, configuration_version_id, configuration_id, organization_id)
        references test_suites (id, configuration_version_id, configuration_id, organization_id)
        on delete cascade,
      constraint fk_test_definitions_input
        foreign key (input_id, configuration_id, organization_id)
        references test_definition_inputs (id, configuration_id, organization_id)
        deferrable initially deferred,
      constraint ck_test_definitions_name_trimmed check (name = btrim(name)),
      constraint ck_test_definitions_name_length check (char_length(name) between 1 and 200),
      constraint ck_test_definitions_description_length check (char_length(description) <= 2000),
      constraint ck_test_definitions_target_pipeline_length check (char_length(target_pipeline) between 1 and 200),
      constraint ck_test_definitions_signal check (signal in ('traces', 'metrics', 'logs')),
      constraint ck_test_definitions_pipeline_signal check (split_part(target_pipeline, '/', 1) = signal),
      constraint ck_test_definitions_duration_seconds check (duration_seconds between 1 and 60)
    );

    comment on table test_definitions is
      'a suite''s test configurations: an input, a pipeline, its signal and a
       duration, run from the Suites subtab. Created and deleted, never
       changed. Visible to whoever can see its configuration; a run queued
       from one takes its input, pipeline, signal and duration on the
       server.';
    comment on column test_definitions.id is
      'the definition''s id (uuidv7). A version copy takes a new one.';
    comment on column test_definitions.organization_id is
      'the configuration''s organization. A hard-deleted organization takes
       its definitions.';
    comment on column test_definitions.configuration_id is
      'the configuration whose visibility the definition follows.';
    comment on column test_definitions.configuration_version_id is
      'the suite''s version (fk_test_definitions_suite).';
    comment on column test_definitions.test_suite_id is
      'the suite it belongs to, in the same version (fk_test_definitions_suite);
       it goes with the suite.';
    comment on column test_definitions.input_id is
      'the input it runs, in the same configuration
       (fk_test_definitions_input), shared with its version copies.';
    comment on column test_definitions.name is
      'trimmed, 1 to 200 characters; the breadcrumb''s second part.
       Configuration text.';
    comment on column test_definitions.description is
      'at most 2,000 characters; the empty string when there is none.
       Configuration text.';
    comment on column test_definitions.target_pipeline is
      'the pipeline a run tests, as the text names it (logs, logs/app), 1 to
       200 characters.';
    comment on column test_definitions.signal is
      'the pipeline''s signal: traces, metrics or logs, the pipeline name''s
       first part (ck_test_definitions_pipeline_signal).';
    comment on column test_definitions.duration_seconds is
      'how long a run lasts, 1 to 60 seconds. No default: the API always
       writes it.';
    comment on column test_definitions.created_by_user_id is
      'the member who created it, or who created the version whose copy it
       is: the insert policy admits only the context''s
       user. Null once their account is hard-deleted.';
    comment on column test_definitions.created_at is
      'written by the API from its clock; a version copy writes the
       version''s time. The suite''s order, with the id.';

    comment on constraint test_definitions_pkey on test_definitions is
      'one row per definition, by its id.';
    comment on constraint test_definitions_organization_id_fkey on test_definitions is
      'the definition''s organization (23503 otherwise); on delete cascade.';
    comment on constraint test_definitions_created_by_user_id_fkey on test_definitions is
      'the definition''s creator (23503 otherwise); on delete set null.';
    comment on constraint fk_test_definitions_suite on test_definitions is
      'a definition names a suite of its own version, configuration and
       organization (23503 otherwise), so it can''t name another version''s
       suite. On delete cascade: a suite''s definitions go with it.';
    comment on constraint fk_test_definitions_input on test_definitions is
      'a definition names an input of its own configuration and organization
       (23503 otherwise). No action, deferrable initially deferred:
       checked at commit, so removing an input a
       definition still names is refused then, while a configuration''s hard
       delete, whose cascade reaches the inputs before the definitions,
       still commits.';
    comment on constraint ck_test_definitions_name_trimmed on test_definitions is
      'the name is trimmed, which the API''s contract does first.';
    comment on constraint ck_test_definitions_name_length on test_definitions is
      'the name is 1 to 200 characters.';
    comment on constraint ck_test_definitions_description_length on test_definitions is
      'the description is at most 2,000 characters.';
    comment on constraint ck_test_definitions_target_pipeline_length on test_definitions is
      'the pipeline''s name is 1 to 200 characters, as a run''s.';
    comment on constraint ck_test_definitions_signal on test_definitions is
      'traces, metrics or logs.';
    comment on constraint ck_test_definitions_pipeline_signal on test_definitions is
      'the pipeline''s name begins with its signal (logs, logs/app): a run
       takes both from the definition with no contract check in between.';
    comment on constraint ck_test_definitions_duration_seconds on test_definitions is
      'a run lasts 1 to 60 seconds, as ck_test_runs_duration_seconds.';

    create index idx_test_definitions_suite_created_at
      on test_definitions (test_suite_id, created_at, id);
    create index idx_test_definitions_input
      on test_definitions (input_id);
    create index idx_test_definitions_organization_configuration
      on test_definitions (organization_id, configuration_id);
    create index idx_test_definitions_created_by_user_id
      on test_definitions (created_by_user_id);

    comment on index idx_test_definitions_suite_created_at is
      'a suite''s definitions in their order (created_at, id): the list and
       the version copy. Led by the suite, it also serves
       fk_test_definitions_suite''s cascade.';
    comment on index idx_test_definitions_input is
      'whether any definition still names an input: the reference count, and
       fk_test_definitions_input''s check when an input is deleted.';
    comment on index idx_test_definitions_organization_configuration is
      'a configuration''s definitions, and an organization''s cascade.';
    comment on index idx_test_definitions_created_by_user_id is
      'a hard-deleted account''s set null; without an index that would scan
       the table.';

    alter table test_definitions enable row level security;

    create policy test_definitions_select on test_definitions
      for select to telflo_platform_runtime
      using (${childVisible("test_definitions")});
    create policy test_definitions_insert on test_definitions
      for insert to telflo_platform_runtime
      with check (${childVisible("test_definitions")}
        and created_by_user_id = ${contextUser});
    create policy test_definitions_update on test_definitions
      for update to telflo_platform_runtime
      using (false);
    create policy test_definitions_delete on test_definitions
      for delete to telflo_platform_runtime
      using (${childVisible("test_definitions")});

    comment on policy test_definitions_select on test_definitions is
      'the API''s role sees the definitions of the configurations the
       context''s user can see.';
    comment on policy test_definitions_insert on test_definitions is
      'the API''s role adds a definition only to a configuration the
       context''s user can see, as that user (42501 otherwise): its creator
       can''t be forged.';
    comment on policy test_definitions_update on test_definitions is
      'a definition never changes: the API''s role updates none.';
    comment on policy test_definitions_delete on test_definitions is
      'the API''s role deletes only the definitions it can see.';

    create table test_templates (
      id                  uuid         primary key default uuidv7(),
      name                text         not null,
      description         text         not null default '',
      receiver_type       text         not null,
      signal              text         not null,
      file_name           text         not null,
      content_type        text         not null,
      size_bytes          integer      not null,
      sha256              bytea        not null,
      created_by_user_id  uuid         references users(id) on delete set null,
      created_at          timestamptz  not null,
      updated_at          timestamptz  not null,
      deleted_at          timestamptz,
      constraint ck_test_templates_name_trimmed check (name = btrim(name)),
      constraint ck_test_templates_name_length check (char_length(name) between 1 and 200),
      constraint ck_test_templates_description_length check (char_length(description) <= 2000),
      constraint ck_test_templates_receiver_type_format check (receiver_type ~ '^[a-z][a-z0-9_]{0,63}$'),
      constraint ck_test_templates_signal check (signal in ('traces', 'metrics', 'logs')),
      constraint ck_test_templates_file_name_length check (char_length(file_name) between 1 and 255),
      constraint ck_test_templates_content_type_present
        check (btrim(content_type) <> '' and char_length(content_type) <= 255),
      constraint ck_test_templates_size_bytes check (size_bytes between 0 and 10485760),
      constraint ck_test_templates_sha256_length check (octet_length(sha256) = 32)
    );

    revoke delete on test_templates from telflo_platform_runtime;

    comment on table test_templates is
      'product-wide sample test inputs. Global: no organization column, no
       row-level security. Members read the live ones through the API; only
       a product admin (users.is_product_admin) writes them, which the API
       decides. Deletes are soft (deleted_at), so the API''s role has no
       DELETE. The bytes are in the FileStore at global/test-templates/<id>;
       definitions and runs keep their own copies.';
    comment on column test_templates.id is
      'the template''s id, which names its bytes in the FileStore.';
    comment on column test_templates.name is
      'trimmed, 1 to 200 characters. Configuration text: never in
       a log line, an attribute, an audit row or a URL.';
    comment on column test_templates.description is
      'at most 2,000 characters; the empty string when there is none.';
    comment on column test_templates.receiver_type is
      'the receiver the sample suits, a palette receiver''s value (otlp,
       filelog): lower-case words, which the API checks against its list.';
    comment on column test_templates.signal is
      'the sample''s signal: traces, metrics or logs.';
    comment on column test_templates.file_name is
      'the uploaded file''s own name with its extension, 1 to 255
       characters; a run''s input_name copies it. Never changed.';
    comment on column test_templates.content_type is
      'from the name''s last extension. Never changed.';
    comment on column test_templates.size_bytes is
      'the bytes'' size, at most 10,485,760. Never changed.';
    comment on column test_templates.sha256 is
      'the bytes'' SHA-256, 32 bytes, as the FileStore computed it while
       writing them. Never changed.';
    comment on column test_templates.created_by_user_id is
      'the product admin who uploaded it. Null once their account is
       hard-deleted; never changed otherwise.';
    comment on column test_templates.created_at is
      'written by the API from its clock, never now(), as flows''. The list
       shows the newest first.';
    comment on column test_templates.updated_at is
      'written by the API from its clock on create and on every change.';
    comment on column test_templates.deleted_at is
      'when a product admin deleted it, from the API''s clock; null while it
       is live. Set once, never cleared (test_templates_guard).';

    comment on constraint test_templates_pkey on test_templates is
      'one row per template, by its id.';
    comment on constraint test_templates_created_by_user_id_fkey on test_templates is
      'the template''s uploader (23503 otherwise); on delete set null, which
       the guard trigger allows.';
    comment on constraint ck_test_templates_name_trimmed on test_templates is
      'the name is trimmed, which the API''s contract does first.';
    comment on constraint ck_test_templates_name_length on test_templates is
      'the name is 1 to 200 characters.';
    comment on constraint ck_test_templates_description_length on test_templates is
      'the description is at most 2,000 characters.';
    comment on constraint ck_test_templates_receiver_type_format on test_templates is
      'a receiver type is lower-case words joined by underscores, at most 64
       characters; the API checks it against its list.';
    comment on constraint ck_test_templates_signal on test_templates is
      'traces, metrics or logs.';
    comment on constraint ck_test_templates_file_name_length on test_templates is
      'the file''s name is 1 to 255 characters.';
    comment on constraint ck_test_templates_content_type_present on test_templates is
      'a content type is named, at most 255 characters.';
    comment on constraint ck_test_templates_size_bytes on test_templates is
      'a template is at most 10 MiB, as an upload.';
    comment on constraint ck_test_templates_sha256_length on test_templates is
      'a SHA-256 is 32 bytes.';

    create index idx_test_templates_live_created_at
      on test_templates (created_at desc, id desc) where deleted_at is null;
    create index idx_test_templates_created_by_user_id
      on test_templates (created_by_user_id);

    comment on index idx_test_templates_live_created_at is
      'the live templates, newest first: the list.';
    comment on index idx_test_templates_created_by_user_id is
      'a hard-deleted account''s set null; without an index that would scan
       the table.';

    -- Not SECURITY DEFINER: it reads only the row it is given. P0001, with a
    -- message naming only the template's id.
    create function refuse_test_template_change() returns trigger
    language plpgsql
    set search_path = pg_catalog, platform
    as $$
    begin
      if (new.id, new.file_name, new.content_type, new.size_bytes, new.sha256, new.created_at)
           is distinct from
         (old.id, old.file_name, old.content_type, old.size_bytes, old.sha256, old.created_at)
         or (new.created_by_user_id is distinct from old.created_by_user_id
             and new.created_by_user_id is not null)
      then
        raise exception 'test template % keeps its file and its creator', old.id;
      end if;
      if old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at then
        raise exception 'test template % stays deleted', old.id;
      end if;
      return new;
    end;
    $$;

    create trigger test_templates_guard
      before update on test_templates
      for each row execute function refuse_test_template_change();

    comment on function refuse_test_template_change() is
      'a template''s file never changes: its id,
       file name, content type, size, SHA-256 and created_at are fixed, its
       creator changes only to null (the users foreign key''s on delete set
       null), and deleted_at goes only from null to a time, never back or to
       another time. Its name, description, receiver type and signal may
       change (the admin''s edit). P0001, naming only the template''s id. Not
       SECURITY DEFINER: it reads only the row it is given.';
    comment on trigger test_templates_guard on test_templates is
      'before update, for every role on a plain UPDATE, the API''s and the
       tables'' owner alike. Only an operator can bypass it (ALTER TABLE …
       DISABLE TRIGGER, session_replication_role = replica).';

    alter table test_runs
      add column test_suite_id         uuid,
      add column test_suite_name       text,
      add column test_definition_id    uuid,
      add column test_definition_name  text,
      add constraint ck_test_runs_test_suite_name_length
        check (test_suite_name is null or char_length(test_suite_name) between 1 and 200),
      add constraint ck_test_runs_test_definition_name_length
        check (test_definition_name is null or char_length(test_definition_name) between 1 and 200),
      add constraint ck_test_runs_breadcrumb_together
        check (num_nulls(${breadcrumbColumns.join(", ")}) in (0, ${breadcrumbColumns.length}));

    comment on column test_runs.test_suite_id is
      'for a run queued from a definition, or a re-run of one, the suite it
       came from; null otherwise. No foreign key, as
       source_run_id: the suite may be deleted, and the run keeps its
       snapshot.';
    comment on column test_runs.test_suite_name is
      'the suite''s name when the run was queued, the breadcrumb''s first
       part, 1 to 200 characters; null exactly when test_suite_id is.
       Configuration text.';
    comment on column test_runs.test_definition_id is
      'for a run queued from a definition, or a re-run of one, the definition
       it came from; null otherwise. No foreign key, as source_run_id.';
    comment on column test_runs.test_definition_name is
      'the definition''s name when the run was queued, the breadcrumb''s
       second part, 1 to 200 characters; null exactly when
       test_definition_id is. Configuration text.';
    comment on constraint ck_test_runs_test_suite_name_length on test_runs is
      'a suite''s name is 1 to 200 characters, as test_suites.name.';
    comment on constraint ck_test_runs_test_definition_name_length on test_runs is
      'a definition''s name is 1 to 200 characters, as test_definitions.name.';
    comment on constraint ck_test_runs_breadcrumb_together on test_runs is
      'the breadcrumb''s four columns are all set (a run from a definition)
       or all null.';

    create index idx_test_runs_test_definition_id
      on test_runs (test_definition_id) where test_definition_id is not null;

    comment on index idx_test_runs_test_definition_id is
      'a definition''s runs, for the runs queued from definitions only.';
${runGuard([...snapshotColumns028, ...breadcrumbColumns])}
    comment on function refuse_test_run_change() is
      'the run''s rules, kept by the database for every role: its snapshot
       and identity, the breadcrumb (test_suite_id, test_suite_name,
       test_definition_id, test_definition_name) included, never change, and
       queued_by_user_id only to null (the users foreign key''s on delete set
       null); its status goes only queued → running or failed, and running →
       succeeded, failed or queued (release); and a run that keeps its status
       changes in nothing else, so a finished run never changes. P0001,
       naming only the run''s id. Not SECURITY DEFINER: it reads only the row
       it is given.';
${waitingForContextUser(`
         and r.organization_id = ${contextOrganization}`)}
    comment on function test_runs_waiting_for_context_user() is
      'how many runs the context''s user has waiting in the context''s
       organization (the cap of 50, per person, per organization). A count
       only; 0 without a user or an organization in the context. SECURITY
       DEFINER, as migration 028 made it: it counts runs the context may not
       see.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`${waitingForContextUser("")}
    comment on function test_runs_waiting_for_context_user() is
      'how many runs the context''s user has waiting, in every organization
       (a cap of 50). A count only; 0 without a user in the
       context. SECURITY DEFINER, since their other organizations'' runs are
       invisible here.';
${runGuard(snapshotColumns028)}
    comment on function refuse_test_run_change() is
      'the run''s rules, kept by the database for every role: its snapshot
       and identity never change, and
       queued_by_user_id only to null (the users foreign key''s on delete
       set null); its status goes only queued → running or failed, and
       running → succeeded, failed or queued (release); and a run that keeps
       its status changes in nothing else, so a finished run never changes.
       P0001, naming only the run''s id. Not SECURITY DEFINER: it reads only
       the row it is given.';

    drop index idx_test_runs_test_definition_id;
    alter table test_runs
      drop constraint ck_test_runs_breadcrumb_together,
      drop constraint ck_test_runs_test_definition_name_length,
      drop constraint ck_test_runs_test_suite_name_length,
      drop column test_definition_name,
      drop column test_definition_id,
      drop column test_suite_name,
      drop column test_suite_id;

    drop table test_templates;
    drop function refuse_test_template_change();
    drop table test_definitions;
    drop table test_definition_inputs;
    drop table test_suites;
    drop function refuse_test_suite_identity_change();
  `);
};
