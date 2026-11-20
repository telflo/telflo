/**
 * Test runs and test files.
 *
 *   * test_input_files: a person's uploads and saved samples ("My Files") in
 *     one organization. The bytes live in the FileStore at
 *     organizations/<org>/users/<owner>/test-inputs/<id>; the row holds what
 *     the list shows. Row-level security admits the owner in the owner's
 *     organization only: select, insert and delete; no update (a file never
 *     changes). The owner's account going takes the rows (on delete cascade);
 *     their bytes stay on disk until a pruning job removes them (not built
 *     yet).
 *   * test_runs: the run queue and every run's record. A run is a snapshot
 *     taken when it is queued and never changed: the text, the pipeline and
 *     its signal, the duration, the collector pin and the input's name. Its
 *     status goes queued → running → succeeded or failed, or queued → failed;
 *     a running run whose tester refused it before starting goes back to
 *     queued (release). Nothing else.
 *       - Composite foreign keys tie it to its configuration and version in
 *         its own organization, as configuration_versions' do, and to the
 *         configuration's distribution and a version of the catalog.
 *         queued_by_user_id becomes null when the account is hard-deleted.
 *       - Row-level security follows migration 021's child-visible pattern: a
 *         run is visible to whoever can see its configuration, so a draft's
 *         runs are its author's and a published configuration's runs, past and
 *         future, every member's. A member inserts only a queued run, as
 *         themselves, at now() (no backdating), on a configuration they can
 *         see. The API's role updates and deletes nothing (using (false), as
 *         migration 022's delete policies): runs change only through the
 *         dispatcher's functions, and are never deleted.
 *       - A guard trigger, for every role, refuses a change to the snapshot
 *         (queued_by_user_id may only become null), any transition but the
 *         five above, and any change of a run that keeps its status.
 *       - Checks: the status, the signal, the duration (1 to 60), the text
 *         (262,144 characters), the sizes (10,485,760 bytes), the times and
 *         the lease tied to the status, and results only on a finished run.
 *   * otelcol_testing_state: one row, the tester's health as every API process
 *     sees it. Global; the API's role reads it and writes it only through
 *     otelcol_testing_mark.
 *   * The dispatcher's functions: SECURITY DEFINER, EXECUTE for
 *     telflo_platform_runtime only, search_path fixed to pg_catalog, platform
 *     with every table named with its schema. Each refuses (42501) unless the
 *     database context is the dispatcher's: telflo.dispatcher = 'on', with
 *     telflo.user_id and telflo.organization_id empty, which only
 *     apps/api/src/database/context.ts's withDispatcherContext sets. A guard
 *     against bugs, as the other definer functions' are: the same process
 *     holds the one login. Each takes its time once, from clock_timestamp()
 *     after its locks, and stamps every column with it: never now(), the
 *     transaction's start, which can be older than a run queued or claimed
 *     while the function waited, and would order a run's times backwards.
 *       - test_runs_claim(slots, lease overhead): each person's turn in
 *         order, under an advisory lock, so several API processes never run
 *         more than slots at once; only under READ COMMITTED, since its cap
 *         relies on each statement's snapshot being taken after the lock. It
 *         first fails, rather than runs, a waiting run whose configuration
 *         or organization has been deleted.
 *       - test_runs_finish(run, lease, succeeded, results) and
 *         test_runs_release(run, lease): only while the lease is the
 *         caller's.
 *       - test_runs_reap(message): running runs past their lease, on the
 *         database's clock.
 *       - test_runs_fail_waiting(down for, message): waiting runs, once the
 *         tester has been down that long.
 *       - otelcol_testing_mark(up): the health monitor's change.
 *   * Two functions answer a member's request (SECURITY DEFINER, counts
 *     only): test_runs_ahead(run ids), "n ahead" for the runs the context's
 *     user can see in the context's organization, and
 *     test_runs_waiting_for_context_user(), the context's user's waiting
 *     runs in every organization (the cap of 50).
 *
 * Migration 009's default privileges give telflo_platform_runtime select,
 * insert, update and delete on the three tables; otelcol_testing_state's
 * insert, update and delete are revoked.
 *
 * down drops the functions, the trigger's function and the three tables,
 * with their constraints, indexes, policies, trigger and comments: exactly
 * what up added.
 */

const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;
const contextUser = `nullif(current_setting('telflo.user_id', true), '')::uuid`;

/** Migration 021's: a child row of `table` whose configuration the context may see. */
const childVisible = (table) => `organization_id = ${contextOrganization}
        and exists (select 1 from configurations c
                     where c.id = ${table}.configuration_id
                       and c.organization_id = ${table}.organization_id)`;

/** A test file of the context's user in the context's organization. */
const ownFile = `organization_id = ${contextOrganization}
        and owner_user_id = ${contextUser}`;

/** The columns a finished run's results fill; every one null until then. */
const resultColumns = [
  "strategy",
  "kwok_enabled",
  "mutated_yaml",
  "mutations",
  "compatibility",
  "logs",
  "timings",
  "output_size_bytes",
  "output_truncated",
  "decoded_input_size_bytes",
  "decoded_input_truncated",
  "error_code",
  "error_message",
];

/** The snapshot's columns and the run's identity: never changed. */
const snapshotColumns = [
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

/**
 * The per-person ranking of the waiting runs, shared by the claim and
 * "n ahead". The runs whose person is null (a hard-deleted account's) share
 * one turn sequence, as one person's: the partition and the join both group
 * the nulls together.
 */
const waitingRanked = `running as (
      select r.queued_by_user_id as person, count(*) as n
        from platform.test_runs r
       where r.status = 'running'
       group by r.queued_by_user_id
    ), waiting as (
      select r.id, r.queued_at,
             coalesce(g.n, 0)
               + row_number() over (partition by r.queued_by_user_id order by r.queued_at, r.id)
               - 1 as turn
        from platform.test_runs r
        left join running g on g.person is not distinct from r.queued_by_user_id
       where r.status = 'queued'
    )`;

/** Every function this migration grants, with its arguments. */
const grantedFunctions = [
  "test_runs_claim(integer, integer)",
  "test_runs_finish(uuid, uuid, boolean, jsonb)",
  "test_runs_release(uuid, uuid)",
  "test_runs_reap(text)",
  "test_runs_fail_waiting(interval, text)",
  "otelcol_testing_mark(boolean)",
  "test_runs_ahead(uuid[])",
  "test_runs_waiting_for_context_user()",
];

export const up = (pgm) => {
  pgm.sql(`
    create table test_input_files (
      id               uuid         primary key default uuidv7(),
      organization_id  uuid         not null references organizations(id) on delete cascade,
      owner_user_id    uuid         not null references users(id) on delete cascade,
      display_name     text         not null,
      file_name        text         not null,
      description      text         not null default '',
      content_type     text         not null,
      size_bytes       integer      not null,
      sha256           bytea        not null,
      created_at       timestamptz  not null default now(),
      constraint ck_test_input_files_display_name_trimmed check (display_name = btrim(display_name)),
      constraint ck_test_input_files_display_name_length check (char_length(display_name) between 1 and 200),
      constraint ck_test_input_files_file_name_length check (char_length(file_name) between 1 and 255),
      constraint ck_test_input_files_description_length check (char_length(description) <= 2000),
      constraint ck_test_input_files_content_type_present
        check (btrim(content_type) <> '' and char_length(content_type) <= 255),
      constraint ck_test_input_files_size_bytes check (size_bytes between 0 and 10485760),
      constraint ck_test_input_files_sha256_length check (octet_length(sha256) = 32)
    );

    comment on table test_input_files is
      'a person''s test files in one organization, "My Files": uploads and
       saved samples, listed only for their owner. The bytes are in the
       FileStore under the owner''s folder, reached only through the API. A
       file never changes; deleting one removes the row, then its bytes. Runs
       keep their own copies.';
    comment on column test_input_files.id is
      'the file''s id, which names its bytes in the FileStore.';
    comment on column test_input_files.organization_id is
      'the organization the file was uploaded in. A hard-deleted organization
       takes its files'' rows (their bytes stay on disk until they are
       pruned).';
    comment on column test_input_files.owner_user_id is
      'the person who uploaded or pasted it, the only one who sees it. On
       delete cascade: a hard-deleted account takes its rows, and its bytes
       stay on disk until they are pruned.';
    comment on column test_input_files.display_name is
      'the name the list shows, trimmed, 1 to 200 characters. Private text:
       never in a log line, an attribute, an audit row or a URL.';
    comment on column test_input_files.file_name is
      'the uploaded file''s own name, or a pasted sample''s (name.json or
       name.log), 1 to 255 characters; a run''s input_name copies it.
       Private text, as the display name.';
    comment on column test_input_files.description is
      'at most 2,000 characters; the empty string when there is none.
       Private text.';
    comment on column test_input_files.content_type is
      'from the name''s last extension, never the
       browser''s MIME type or a sniff.';
    comment on column test_input_files.size_bytes is
      'the bytes'' size, at most 10,485,760.';
    comment on column test_input_files.sha256 is
      'the bytes'' SHA-256, 32 bytes, as the FileStore computed it while
       writing them.';
    comment on column test_input_files.created_at is
      'when the row was inserted, by the database''s clock. The list shows
       the newest first.';

    comment on constraint test_input_files_pkey on test_input_files is
      'one row per file, by its id.';
    comment on constraint test_input_files_organization_id_fkey on test_input_files is
      'the file''s organization (23503 otherwise); on delete cascade.';
    comment on constraint test_input_files_owner_user_id_fkey on test_input_files is
      'the file''s owner (23503 otherwise); on delete cascade: a hard-deleted
       account takes its files'' rows.';
    comment on constraint ck_test_input_files_display_name_trimmed on test_input_files is
      'the display name is trimmed, which the API''s contract does first.';
    comment on constraint ck_test_input_files_display_name_length on test_input_files is
      'the display name is 1 to 200 characters.';
    comment on constraint ck_test_input_files_file_name_length on test_input_files is
      'the file''s name is 1 to 255 characters.';
    comment on constraint ck_test_input_files_description_length on test_input_files is
      'the description is at most 2,000 characters.';
    comment on constraint ck_test_input_files_content_type_present on test_input_files is
      'a content type is named, at most 255 characters.';
    comment on constraint ck_test_input_files_size_bytes on test_input_files is
      'an upload is at most 10 MiB, and a sample 1 MiB,
       which the API checks first.';
    comment on constraint ck_test_input_files_sha256_length on test_input_files is
      'a SHA-256 is 32 bytes.';

    create index idx_test_input_files_organization_owner_created_at
      on test_input_files (organization_id, owner_user_id, created_at desc);
    create index idx_test_input_files_owner_user_id
      on test_input_files (owner_user_id);

    comment on index idx_test_input_files_organization_owner_created_at is
      'a person''s files in an organization, newest first: "My Files". Led by
       the organization, it also serves the organization''s cascade.';
    comment on index idx_test_input_files_owner_user_id is
      'a hard-deleted account takes its files; without an index that would
       scan the table.';

    alter table test_input_files enable row level security;

    create policy test_input_files_select on test_input_files
      for select to telflo_platform_runtime
      using (${ownFile});
    create policy test_input_files_insert on test_input_files
      for insert to telflo_platform_runtime
      with check (${ownFile});
    create policy test_input_files_update on test_input_files
      for update to telflo_platform_runtime
      using (false);
    create policy test_input_files_delete on test_input_files
      for delete to telflo_platform_runtime
      using (${ownFile});

    comment on policy test_input_files_select on test_input_files is
      'the API''s role sees only the context''s user''s own files in the
       context''s organization: nobody else''s, admins
       included.';
    comment on policy test_input_files_insert on test_input_files is
      'the API''s role adds a file only for the context''s user in the
       context''s organization (42501 otherwise).';
    comment on policy test_input_files_update on test_input_files is
      'a test file never changes: the API''s role updates none.';
    comment on policy test_input_files_delete on test_input_files is
      'the API''s role deletes only the context''s user''s own files in the
       context''s organization.';

    create table test_runs (
      id                        uuid         primary key default uuidv7(),
      organization_id           uuid         not null references organizations(id) on delete cascade,
      configuration_id          uuid         not null,
      configuration_version_id  uuid         not null,
      queued_by_user_id         uuid         references users(id) on delete set null,
      source_run_id             uuid,
      yaml                      text         not null,
      target_pipeline           text         not null,
      signal                    text         not null,
      duration_seconds          smallint     not null,
      collector_distribution    text         not null,
      collector_version         text         not null,
      input_name                text         not null,
      input_size_bytes          integer      not null,
      status                    text         not null default 'queued',
      queued_at                 timestamptz  not null default now(),
      started_at                timestamptz,
      finished_at               timestamptz,
      lease_id                  uuid,
      lease_expires_at          timestamptz,
      strategy                  text,
      kwok_enabled              boolean,
      mutated_yaml              text,
      mutations                 jsonb,
      compatibility             jsonb,
      logs                      text,
      timings                   jsonb,
      output_size_bytes         integer,
      output_truncated          boolean,
      decoded_input_size_bytes  integer,
      decoded_input_truncated   boolean,
      error_code                text,
      error_message             text,
      constraint fk_test_runs_configuration
        foreign key (configuration_id, organization_id)
        references configurations (id, organization_id),
      constraint fk_test_runs_configuration_version
        foreign key (configuration_version_id, configuration_id, organization_id)
        references configuration_versions (id, configuration_id, organization_id),
      constraint fk_test_runs_configuration_distribution
        foreign key (configuration_id, collector_distribution)
        references configurations (id, collector_distribution),
      constraint fk_test_runs_collector_version
        foreign key (collector_distribution, collector_version)
        references collector_versions (distribution, version),
      constraint ck_test_runs_status check (status in ('queued', 'running', 'succeeded', 'failed')),
      constraint ck_test_runs_signal check (signal in ('traces', 'metrics', 'logs')),
      constraint ck_test_runs_duration_seconds check (duration_seconds between 1 and 60),
      constraint ck_test_runs_yaml_length check (char_length(yaml) <= 262144),
      constraint ck_test_runs_target_pipeline_length check (char_length(target_pipeline) between 1 and 200),
      constraint ck_test_runs_input_name_length check (char_length(input_name) between 1 and 255),
      constraint ck_test_runs_input_size_bytes check (input_size_bytes between 0 and 10485760),
      constraint ck_test_runs_output_size_bytes
        check (output_size_bytes is null or output_size_bytes between 0 and 10485760),
      constraint ck_test_runs_decoded_input_size_bytes
        check (decoded_input_size_bytes is null or decoded_input_size_bytes between 0 and 10485760),
      constraint ck_test_runs_output_truncated
        check ((output_size_bytes is null) = (output_truncated is null)),
      constraint ck_test_runs_decoded_input_truncated
        check ((decoded_input_size_bytes is null) = (decoded_input_truncated is null)),
      constraint ck_test_runs_state check (
        (status = 'queued'
          and started_at is null and finished_at is null and lease_id is null and lease_expires_at is null)
        or (status = 'running'
          and started_at is not null and finished_at is null and lease_id is not null and lease_expires_at is not null)
        or (status in ('succeeded', 'failed')
          and finished_at is not null and lease_id is null and lease_expires_at is null)),
      constraint ck_test_runs_times_ordered check (
        (started_at is null or started_at >= queued_at)
        and (finished_at is null or finished_at >= coalesce(started_at, queued_at))),
      constraint ck_test_runs_results_only_when_finished check (
        status in ('succeeded', 'failed')
        or (${resultColumns.map((column) => `${column} is null`).join(" and ")})),
      constraint ck_test_runs_result_shapes check (
        (mutations is null or jsonb_typeof(mutations) = 'array')
        and (compatibility is null or jsonb_typeof(compatibility) = 'array')
        and (timings is null or jsonb_typeof(timings) = 'object')),
      constraint ck_test_runs_logs_length check (logs is null or char_length(logs) <= 262144),
      constraint ck_test_runs_strategy_length check (strategy is null or char_length(strategy) between 1 and 64),
      constraint ck_test_runs_error_code_format check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$')
    );

    comment on table test_runs is
      'the test-run queue and every run''s record. A run is queued by a
       member, claimed and run by the API''s dispatcher, and finished with the
       tester''s answer. Its snapshot never changes, its status changes only
       through the dispatcher''s functions, and it is never deleted. Its files
       are in the FileStore at organizations/<org>/test-runs/<id>/. Visible to
       whoever can see its configuration.';
    comment on column test_runs.id is
      'the run''s id, chosen by the API (uuidv7) before the insert, since the
       input is copied into the run''s folder first.';
    comment on column test_runs.organization_id is
      'the configuration''s organization (fk_test_runs_configuration). A
       hard-deleted organization takes its runs.';
    comment on column test_runs.configuration_id is
      'the configuration run. A run is visible to whoever can see it, and
       hidden once it is deleted: the repository hides it, and the claim
       fails it if it was waiting.';
    comment on column test_runs.configuration_version_id is
      'the version whose run list shows the run (fk_test_runs_configuration_version).';
    comment on column test_runs.queued_by_user_id is
      'the member who queued it: the person whose turn it takes, and whose
       waiting runs are capped. Null once their
       account is hard-deleted; never changed otherwise.';
    comment on column test_runs.source_run_id is
      'for a re-run, the run whose input it copied; null otherwise. No
       foreign key: an id only, never followed by the database.';
    comment on column test_runs.yaml is
      'the text run, with organization-variable defaults substituted when it
       was queued, at most 262,144 characters. Private: never logged, audited
       or sent to analytics.';
    comment on column test_runs.target_pipeline is
      'the pipeline the tester runs, as the text names it (logs, logs/app).';
    comment on column test_runs.signal is
      'the pipeline''s signal: traces, metrics or logs.';
    comment on column test_runs.duration_seconds is
      'how long the collector runs, 1 to 60 seconds. The lease adds it to
       its overhead.';
    comment on column test_runs.collector_distribution is
      'the configuration''s distribution
       (fk_test_runs_configuration_distribution).';
    comment on column test_runs.collector_version is
      'the collector version run, the pin on screen when it was queued
       (fk_test_runs_collector_version).';
    comment on column test_runs.input_name is
      'the input''s name when it was queued, 1 to 255 characters. Private
       text: never in a log line, an attribute, an audit row or a URL.';
    comment on column test_runs.input_size_bytes is
      'the size of the run''s copy of its input, at most 10,485,760 bytes.';
    comment on column test_runs.status is
      'queued, running, succeeded or failed. queued → running (claimed) →
       succeeded or failed (finished, reaped), queued → failed (the tester
       down, the configuration deleted), and running → queued (released when
       the tester refused before starting). Nothing else: the guard trigger.';
    comment on column test_runs.queued_at is
      'when it was queued, by the database''s clock: the insert policy
       admits only now(), so no run jumps the queue. A released run keeps it.';
    comment on column test_runs.started_at is
      'when the dispatcher claimed it, by the database''s clock after the
       claim''s lock; null while queued, and on a run failed
       while waiting.';
    comment on column test_runs.finished_at is
      'when it succeeded or failed, by the database''s clock after the
       function''s locks; null until then.';
    comment on column test_runs.lease_id is
      'the dispatcher''s claim while it runs: finish and release act only
       with it. Null unless running.';
    comment on column test_runs.lease_expires_at is
      'when the reaper fails the running run, on the database''s clock: the
       claim''s time (its clock after its lock) plus the duration and the
       lease''s overhead. Null unless running.';
    comment on column test_runs.strategy is
      'how the tester fed the input (OTLP replay, filelog or syslog), from its
       answer.';
    comment on column test_runs.kwok_enabled is
      'whether the run used the tester''s fake Kubernetes cluster.';
    comment on column test_runs.mutated_yaml is
      'the text the collector ran, after the tester''s mutations, scrubbed.
       Private, as yaml.';
    comment on column test_runs.mutations is
      'the tester''s mutations, a JSON array (R-001 to R-106).';
    comment on column test_runs.compatibility is
      'the tester''s compatibility findings, a JSON array (C-000 to C-006).';
    comment on column test_runs.logs is
      'the collector''s scrubbed logs, at most 262,144 characters. Private.';
    comment on column test_runs.timings is
      'the run''s phases in milliseconds, a JSON object.';
    comment on column test_runs.output_size_bytes is
      'the size of the run''s stored output, at most 10,485,760 bytes; null
       when there is none.';
    comment on column test_runs.output_truncated is
      'whether the collector wrote more than was kept (R-006); null exactly
       when there is no output.';
    comment on column test_runs.decoded_input_size_bytes is
      'the size of the decoded input stored (OTLP runs), at most 10,485,760
       bytes; null when there is none.';
    comment on column test_runs.decoded_input_truncated is
      'whether the decoded input was cut at its cap; null exactly when there
       is none.';
    comment on column test_runs.error_code is
      'why it failed, a code (interrupted, testing_unavailable,
       configuration_deleted, or the tester''s). Lower-case words.';
    comment on column test_runs.error_message is
      'the failure''s message for the person. Never a path or the text.';

    comment on constraint test_runs_pkey on test_runs is
      'one row per run, by its id.';
    comment on constraint test_runs_organization_id_fkey on test_runs is
      'the run''s organization (23503 otherwise); on delete cascade: a
       hard-deleted organization takes its runs, the only way a run goes.';
    comment on constraint test_runs_queued_by_user_id_fkey on test_runs is
      'the member who queued it (23503 otherwise); on delete set null, which
       the guard trigger allows.';
    comment on constraint fk_test_runs_configuration on test_runs is
      'the composite foreign key: a run names a configuration and
       that configuration''s own organization (23503 otherwise, even for the
       owner). No action: nothing deletes a run but its organization.';
    comment on constraint fk_test_runs_configuration_version on test_runs is
      'a run names a version of its own configuration in its own
       organization (23503 otherwise).';
    comment on constraint fk_test_runs_configuration_distribution on test_runs is
      'a run is pinned to its configuration''s distribution.';
    comment on constraint fk_test_runs_collector_version on test_runs is
      'a run names a version of the catalog.';
    comment on constraint ck_test_runs_status on test_runs is
      'queued, running, succeeded or failed.';
    comment on constraint ck_test_runs_signal on test_runs is
      'traces, metrics or logs.';
    comment on constraint ck_test_runs_duration_seconds on test_runs is
      'a run lasts 1 to 60 seconds.';
    comment on constraint ck_test_runs_yaml_length on test_runs is
      'the text is at most 262,144 characters, as a version''s.';
    comment on constraint ck_test_runs_target_pipeline_length on test_runs is
      'the pipeline''s name is 1 to 200 characters.';
    comment on constraint ck_test_runs_input_name_length on test_runs is
      'the input''s name is 1 to 255 characters, as a test file''s.';
    comment on constraint ck_test_runs_input_size_bytes on test_runs is
      'an input is at most 10 MiB.';
    comment on constraint ck_test_runs_output_size_bytes on test_runs is
      'a stored output is at most 10 MiB (R-006).';
    comment on constraint ck_test_runs_decoded_input_size_bytes on test_runs is
      'a stored decoded input is at most 10 MiB.';
    comment on constraint ck_test_runs_output_truncated on test_runs is
      'an output has its size and its truncation, or neither.';
    comment on constraint ck_test_runs_decoded_input_truncated on test_runs is
      'a decoded input has its size and its truncation, or neither.';
    comment on constraint ck_test_runs_state on test_runs is
      'the times and the lease follow the status: a queued run has neither
       started nor finished nor a lease; a running run has started and holds
       a lease; a finished run has finished and holds no lease.';
    comment on constraint ck_test_runs_times_ordered on test_runs is
      'a run starts after it was queued and finishes after it started.';
    comment on constraint ck_test_runs_results_only_when_finished on test_runs is
      'results (the tester''s answer, an error) only on a succeeded or failed
       run: a queued or running one has none, so a member''s insert carries
       none.';
    comment on constraint ck_test_runs_result_shapes on test_runs is
      'mutations and compatibility are JSON arrays, timings an object.';
    comment on constraint ck_test_runs_logs_length on test_runs is
      'the logs are at most 262,144 characters: the tester sends at most 256
       KiB.';
    comment on constraint ck_test_runs_strategy_length on test_runs is
      'the strategy is a short name.';
    comment on constraint ck_test_runs_error_code_format on test_runs is
      'an error code is lower-case words joined by underscores, at most 64
       characters.';

    create index idx_test_runs_queued
      on test_runs (queued_at, id) where status = 'queued';
    create index idx_test_runs_running
      on test_runs (lease_expires_at) where status = 'running';
    create index idx_test_runs_configuration_version_queued_at
      on test_runs (configuration_version_id, queued_at desc);
    create index idx_test_runs_queued_by_user_queued_at
      on test_runs (queued_by_user_id, queued_at desc);
    create index idx_test_runs_organization_configuration
      on test_runs (organization_id, configuration_id);

    comment on index idx_test_runs_queued is
      'the waiting runs, oldest first: the claim''s and "n ahead"''s ranking.';
    comment on index idx_test_runs_running is
      'the running runs: the claim''s count per person, and the reaper''s
       expired leases.';
    comment on index idx_test_runs_configuration_version_queued_at is
      'a version''s runs, newest first: the run list. Led by the version, it
       also serves fk_test_runs_configuration_version''s lookups.';
    comment on index idx_test_runs_queued_by_user_queued_at is
      'a person''s runs, newest first: the rate limit and the cap on waiting
       runs, and a hard-deleted account''s set null.';
    comment on index idx_test_runs_organization_configuration is
      'fk_test_runs_configuration''s and fk_test_runs_configuration_distribution''s
       lookups of a configuration''s runs, and an organization''s cascade.';

    alter table test_runs enable row level security;

    create policy test_runs_select on test_runs
      for select to telflo_platform_runtime
      using (${childVisible("test_runs")});
    create policy test_runs_insert on test_runs
      for insert to telflo_platform_runtime
      with check (${childVisible("test_runs")}
        and queued_by_user_id = ${contextUser}
        and status = 'queued'
        and queued_at = now());
    create policy test_runs_update on test_runs
      for update to telflo_platform_runtime
      using (false);
    create policy test_runs_delete on test_runs
      for delete to telflo_platform_runtime
      using (false);

    comment on policy test_runs_select on test_runs is
      'the API''s role sees the runs of the configurations the context''s
       user can see (configurations_select applies inside the exists): a
       draft''s runs are its author''s, a published
       configuration''s every member''s, past and future. A deleted
       configuration''s included: the repository hides those.';
    comment on policy test_runs_insert on test_runs is
      'the API''s role queues a run only on a configuration the context''s
       user can see, as that user, queued, at now() (a backdated run can''t
       jump the queue); results are refused by
       ck_test_runs_results_only_when_finished. 42501 otherwise.';
    comment on policy test_runs_update on test_runs is
      'the API''s role updates no run: a run changes only through the
       dispatcher''s functions.';
    comment on policy test_runs_delete on test_runs is
      'the API''s role deletes no run.';

    -- Not SECURITY DEFINER: it reads only the row it is given, as whatever
    -- role runs the update. P0001 (raise_exception), as migrations 020's
    -- and 022's triggers raise, with a message naming only the run's id.
    create function refuse_test_run_change() returns trigger
    language plpgsql
    set search_path = pg_catalog, platform
    as $$
    declare
      kept platform.test_runs;
    begin
      if (${snapshotColumns.map((column) => `new.${column}`).join(", ")})
           is distinct from
         (${snapshotColumns.map((column) => `old.${column}`).join(", ")})
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

    create trigger test_runs_guard
      before update on test_runs
      for each row execute function refuse_test_run_change();

    comment on function refuse_test_run_change() is
      'the run''s rules, kept by the database for every role: its snapshot
       and identity never change, and
       queued_by_user_id only to null (the users foreign key''s on delete
       set null); its status goes only queued → running or failed, and
       running → succeeded, failed or queued (release); and a run that keeps
       its status changes in nothing else, so a finished run never changes.
       P0001, naming only the run''s id. Not SECURITY DEFINER: it reads only
       the row it is given.';
    comment on trigger test_runs_guard on test_runs is
      'before update, for every role on a plain UPDATE: the dispatcher''s
       functions (which run as the tables'' owner) and the owner alike. Only
       an operator can bypass it (ALTER TABLE … DISABLE TRIGGER,
       session_replication_role = replica).';

    create table otelcol_testing_state (
      id          boolean      primary key default true,
      down_since  timestamptz,
      constraint ck_otelcol_testing_state_singleton check (id)
    );

    insert into otelcol_testing_state default values;

    revoke insert, update, delete on otelcol_testing_state from telflo_platform_runtime;

    comment on table otelcol_testing_state is
      'the tester''s health as every API process sees it: one row. Global:
       the tester serves
       every organization. The API''s role reads it (queuing refuses while it
       is down) and changes it only through otelcol_testing_mark.';
    comment on column otelcol_testing_state.id is
      'always true: the table holds one row (ck_otelcol_testing_state_singleton).';
    comment on column otelcol_testing_state.down_since is
      'when a health monitor counted the tester down (its second failed check
       in a row), on the database''s clock; null while it is up.';
    comment on constraint otelcol_testing_state_pkey on otelcol_testing_state is
      'the row''s key, always true.';
    comment on constraint ck_otelcol_testing_state_singleton on otelcol_testing_state is
      'one row only: its key is true.';

    -- The dispatcher's context. Not granted to anyone: only the definer
    -- functions below, running as the owner, call it.
    create function test_runs_require_dispatcher() returns void
    language plpgsql
    stable
    set search_path = pg_catalog, platform
    as $$
    begin
      if coalesce(current_setting('telflo.dispatcher', true), '') <> 'on'
         or coalesce(current_setting('telflo.organization_id', true), '') <> ''
         or coalesce(current_setting('telflo.user_id', true), '') <> ''
      then
        raise exception 'only the test-run dispatcher may do this'
          using errcode = 'insufficient_privilege';
      end if;
    end;
    $$;

    revoke execute on function test_runs_require_dispatcher() from public;

    comment on function test_runs_require_dispatcher() is
      'refuses (42501) unless the database context is the test-run
       dispatcher''s: telflo.dispatcher = ''on'', with telflo.user_id and
       telflo.organization_id empty, as withDispatcherContext sets it. A
       member''s request carries its user and organization, so it can''t
       reach the dispatcher''s functions by mistake. EXECUTE for no one: the
       dispatcher''s functions call it as their owner.';

    create function test_runs_claim(p_slots integer, p_lease_overhead_seconds integer)
    returns table (
      run_id                  uuid,
      organization_id         uuid,
      lease_id                uuid,
      lease_expires_at        timestamptz,
      yaml                    text,
      target_pipeline         text,
      signal                  text,
      duration_seconds        smallint,
      collector_distribution  text,
      collector_version       text
    )
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      moment timestamptz;
    begin
      perform platform.test_runs_require_dispatcher();
      -- The cap below counts the running runs in a statement that must see
      -- every earlier claim's commit: a snapshot per statement, taken after
      -- the lock. REPEATABLE READ or SERIALIZABLE would read the queue as it
      -- was when the transaction began, and could run more than p_slots.
      if current_setting('transaction_isolation') <> 'read committed' then
        raise exception 'the claim runs only under read committed'
          using errcode = 'invalid_transaction_state';
      end if;
      if p_slots is null or p_slots < 0 or p_lease_overhead_seconds is null or p_lease_overhead_seconds < 0 then
        raise exception 'the claim takes a number of slots and a lease overhead, neither negative'
          using errcode = 'invalid_parameter_value';
      end if;
      -- One claim at a time across every API process. Under READ COMMITTED
      -- each statement below takes its snapshot after the lock is held, so
      -- it sees every earlier claim's running runs.
      perform pg_advisory_xact_lock(hashtext('telflo.test_runs_claim'));
      -- The claim's one time, read once the lock is held:
      -- every run queued before it is older. A run queued later, which a
      -- statement below could still see, waits for the next claim, so no
      -- run starts or fails before it was queued.
      moment := clock_timestamp();
      -- A waiting run whose configuration or organization is deleted fails
      -- here, rather than runs. Its files stay.
      update platform.test_runs t
         set status = 'failed',
             finished_at = moment,
             error_code = 'configuration_deleted',
             error_message = 'The configuration was deleted before the run started.'
        from platform.configurations c, platform.organizations o
       where t.status = 'queued'
         and t.queued_at <= moment
         and c.id = t.configuration_id
         and c.organization_id = t.organization_id
         and o.id = t.organization_id
         and (c.deleted_at is not null or o.deleted_at is not null);
      return query
      with ${waitingRanked}, free as (
        select greatest(p_slots - coalesce((select sum(g.n) from running g), 0), 0)::integer as slots
      ), picked as (
        select w.id
          from waiting w
         where w.queued_at <= moment
         order by w.turn, w.queued_at, w.id
         limit (select f.slots from free f)
      ), locked as (
        select r.id
          from platform.test_runs r
         where r.id in (select p.id from picked p)
           and r.status = 'queued'
           for update skip locked
      )
      update platform.test_runs t
         set status = 'running',
             started_at = moment,
             lease_id = gen_random_uuid(),
             lease_expires_at = moment + make_interval(secs => t.duration_seconds + p_lease_overhead_seconds)
        from locked l
       where t.id = l.id
      returning t.id, t.organization_id, t.lease_id, t.lease_expires_at, t.yaml, t.target_pipeline,
                t.signal, t.duration_seconds, t.collector_distribution, t.collector_version;
    end;
    $$;

    comment on function test_runs_claim(integer, integer) is
      'the dispatcher''s claim: under an advisory lock, fails each waiting run
       whose configuration or organization is deleted (configuration_deleted),
       then marks running, with a new lease expiring after the run''s duration
       plus p_lease_overhead_seconds, as many waiting runs as p_slots leaves free
       beside the runs already running, in every organization. Each slot goes
       to the oldest waiting run of the person with the fewest runs running,
       then the oldest: the order (turn, queued_at, id), where a run''s turn
       is its person''s running runs plus its place among their waiting ones.
       Runs with no person (their account hard-deleted) share one turn
       sequence, as one person''s. Its time is the clock once the lock is
       held: a run queued after that waits for the next
       claim. Returns each claimed run''s snapshot, organization and lease.
       Only under READ COMMITTED (25000 otherwise): its cap needs each
       statement''s own snapshot. Commit at once: the lock is held until
       then. The dispatcher only (42501).';

    create function test_runs_finish(p_run_id uuid, p_lease_id uuid, p_succeeded boolean, p_results jsonb)
    returns boolean
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      moment timestamptz;
      finished integer;
    begin
      perform platform.test_runs_require_dispatcher();
      if p_succeeded is null or p_results is null or jsonb_typeof(p_results) <> 'object' then
        raise exception 'a finish takes whether the run succeeded and its results as an object'
          using errcode = 'invalid_parameter_value';
      end if;
      if exists (select 1 from jsonb_object_keys(p_results) k
                  where k not in (${resultColumns.map((column) => `'${column}'`).join(", ")})) then
        raise exception 'a finish''s results name only the result columns'
          using errcode = 'invalid_parameter_value';
      end if;
      -- The run's row first, then the time: its claim has
      -- committed, so the clock is past its start.
      perform 1
         from platform.test_runs t
        where t.id = p_run_id
          and t.status = 'running'
          and t.lease_id = p_lease_id
          for update;
      if not found then
        return false;
      end if;
      moment := clock_timestamp();
      update platform.test_runs t
         set status = case when p_succeeded then 'succeeded' else 'failed' end,
             finished_at = moment,
             lease_id = null,
             lease_expires_at = null,
             strategy = p_results ->> 'strategy',
             kwok_enabled = (p_results ->> 'kwok_enabled')::boolean,
             mutated_yaml = p_results ->> 'mutated_yaml',
             mutations = nullif(p_results -> 'mutations', 'null'::jsonb),
             compatibility = nullif(p_results -> 'compatibility', 'null'::jsonb),
             logs = p_results ->> 'logs',
             timings = nullif(p_results -> 'timings', 'null'::jsonb),
             output_size_bytes = (p_results ->> 'output_size_bytes')::integer,
             output_truncated = (p_results ->> 'output_truncated')::boolean,
             decoded_input_size_bytes = (p_results ->> 'decoded_input_size_bytes')::integer,
             decoded_input_truncated = (p_results ->> 'decoded_input_truncated')::boolean,
             error_code = p_results ->> 'error_code',
             error_message = p_results ->> 'error_message'
       where t.id = p_run_id
         and t.status = 'running'
         and t.lease_id = p_lease_id;
      get diagnostics finished = row_count;
      return finished = 1;
    end;
    $$;

    comment on function test_runs_finish(uuid, uuid, boolean, jsonb) is
      'finishes a running run whose lease is p_lease_id: succeeded or failed,
       with the results, a JSON object whose
       keys name result columns (22023 for any other). True when it did;
       false when the run is no longer the caller''s (reaped, or finished
       already), and then nothing changes. The dispatcher only (42501).';

    create function test_runs_release(p_run_id uuid, p_lease_id uuid)
    returns boolean
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      released integer;
    begin
      perform platform.test_runs_require_dispatcher();
      update platform.test_runs t
         set status = 'queued',
             started_at = null,
             lease_id = null,
             lease_expires_at = null
       where t.id = p_run_id
         and t.status = 'running'
         and t.lease_id = p_lease_id;
      get diagnostics released = row_count;
      return released = 1;
    end;
    $$;

    comment on function test_runs_release(uuid, uuid) is
      'puts a running run whose lease is p_lease_id back in the queue, with
       its queued_at, so it keeps its place. Only
       for a tester that refused before starting (busy, starting, a refused
       connection): a run that may have started is never released, so none
       runs twice. True when it did. The dispatcher only (42501).';

    create function test_runs_reap(p_message text)
    returns setof uuid
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      moment timestamptz;
    begin
      perform platform.test_runs_require_dispatcher();
      if p_message is null or btrim(p_message) = '' then
        raise exception 'the reaper takes a message' using errcode = 'invalid_parameter_value';
      end if;
      -- The clock, not the transaction's start: a run
      -- claimed after the transaction began is reaped once its lease is past.
      -- Its locks are the update's own: a run is reaped only when its lease
      -- expired before this time, so it started before it too.
      moment := clock_timestamp();
      return query
      update platform.test_runs t
         set status = 'failed',
             finished_at = moment,
             lease_id = null,
             lease_expires_at = null,
             error_code = 'interrupted',
             error_message = p_message
       where t.status = 'running'
         and t.lease_expires_at < moment
      returning t.id;
    end;
    $$;

    comment on function test_runs_reap(text) is
      'fails every running run past its lease, on the database''s clock when it
       is called, with interrupted and p_message, and returns their ids. A lost
       answer or a restart mid-run ends here; the run is never started again.
       The dispatcher only (42501).';

    create function test_runs_fail_waiting(p_down_for interval, p_message text)
    returns setof uuid
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      moment timestamptz;
    begin
      perform platform.test_runs_require_dispatcher();
      if p_down_for is null or p_down_for <= interval '0' or p_message is null or btrim(p_message) = '' then
        raise exception 'failing waiting runs takes a positive interval and a message'
          using errcode = 'invalid_parameter_value';
      end if;
      -- The clock, not the transaction's start. Its locks
      -- are the update's own: a run queued after this time, which the update
      -- could still see, waits for the next call, so none fails before it
      -- was queued.
      moment := clock_timestamp();
      if not exists (select 1 from platform.otelcol_testing_state s
                      where s.down_since < moment - p_down_for) then
        return;
      end if;
      return query
      update platform.test_runs t
         set status = 'failed',
             finished_at = moment,
             error_code = 'testing_unavailable',
             error_message = p_message
       where t.status = 'queued'
         and t.queued_at <= moment
      returning t.id;
    end;
    $$;

    comment on function test_runs_fail_waiting(interval, text) is
      'once the tester has been down longer than p_down_for, a positive
       interval (22023 otherwise), fails every waiting run, in
       every organization, with testing_unavailable and p_message, and
       returns their ids; while it is up, or down for less, does nothing. Its
       time is the clock when it is called: a run queued
       after that waits for the next call. A run waiting behind a busy but
       working tester never fails here. The dispatcher only (42501).';

    create function otelcol_testing_mark(p_up boolean)
    returns timestamptz
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      moment timestamptz;
      since timestamptz;
    begin
      perform platform.test_runs_require_dispatcher();
      if p_up is null then
        raise exception 'the tester is marked up or down' using errcode = 'invalid_parameter_value';
      end if;
      -- The row first, then the time.
      perform 1 from platform.otelcol_testing_state s for update;
      moment := clock_timestamp();
      update platform.otelcol_testing_state s
         set down_since = case when p_up then null else coalesce(s.down_since, moment) end
      returning s.down_since into since;
      return since;
    end;
    $$;

    comment on function otelcol_testing_mark(boolean) is
      'a health monitor''s change: up
       clears down_since; down sets it to the clock, read after the row''s
       lock, unless it is set already, so it keeps the first
       process''s time. Returns down_since as it is now. The dispatcher only
       (42501).';

    create function test_runs_ahead(p_run_ids uuid[])
    returns table (run_id uuid, ahead integer)
    language sql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
      with ${waitingRanked}, ranked as (
        select w.id, (row_number() over (order by w.turn, w.queued_at, w.id) - 1)::integer as ahead
          from waiting w
      )
      select k.id, k.ahead
        from ranked k
        join platform.test_runs r on r.id = k.id
        join platform.configurations c on c.id = r.configuration_id and c.organization_id = r.organization_id
       where k.id = any (p_run_ids)
         and r.organization_id = ${contextOrganization}
         and (c.created_by_user_id = ${contextUser}
              or platform.configuration_is_published(c.id, c.organization_id))
    $$;

    comment on function test_runs_ahead(uuid[]) is
      '"n ahead": for each waiting run
       of p_run_ids in the context''s organization whose configuration the
       context''s user can see (the select policy''s rule), how many waiting
       runs, in every organization, the claim takes before it. Counts only:
       nothing of another organization''s runs, and nothing for a run the
       context can''t see. SECURITY DEFINER, since the ranking reads every
       organization''s queue.';

    create function test_runs_waiting_for_context_user()
    returns integer
    language sql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
      select count(*)::integer
        from platform.test_runs r
       where r.status = 'queued'
         and r.queued_by_user_id = ${contextUser}
    $$;

    comment on function test_runs_waiting_for_context_user() is
      'how many runs the context''s user has waiting, in every organization
       (a cap of 50). A count only; 0 without a user in the
       context. SECURITY DEFINER, since their other organizations'' runs are
       invisible here.';

    revoke execute on function ${grantedFunctions.join(", ")} from public;
    grant execute on function ${grantedFunctions.join(", ")} to telflo_platform_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop function test_runs_waiting_for_context_user();
    drop function test_runs_ahead(uuid[]);
    drop function otelcol_testing_mark(boolean);
    drop function test_runs_fail_waiting(interval, text);
    drop function test_runs_reap(text);
    drop function test_runs_release(uuid, uuid);
    drop function test_runs_finish(uuid, uuid, boolean, jsonb);
    drop function test_runs_claim(integer, integer);
    drop function test_runs_require_dispatcher();
    drop table otelcol_testing_state;
    drop table test_runs;
    drop function refuse_test_run_change();
    drop table test_input_files;
  `);
};
