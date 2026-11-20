/**
 * Test runs of a YAML with no configuration: the public API's
 * `POST /api/public/v1/test-runs` with `{ yaml }`, a raw-YAML run.
 *
 *   * test_runs.configuration_id and configuration_version_id become
 *     nullable, both null or both set (ck_test_runs_configuration_together);
 *     organization_id's comment says whose organization a YAML run's is.
 *     A run with neither is a YAML run. Its distribution and collector
 *     version are on the row as every run's: fk_test_runs_collector_version
 *     still applies, and the configuration's foreign keys (MATCH SIMPLE)
 *     apply only when a configuration is set.
 *   * Row-level security: the select and insert policies gain "a YAML run of
 *     the context's user in the context's organization" beside migration
 *     028's child-visible rule. A YAML run is its creator's alone: no other
 *     member sees it, an admin included, and the creator sees it only in its
 *     organization. The insert keeps 028's other conditions (queued, as the
 *     context's user, at now()). The update and delete policies, and the
 *     dispatcher's functions' rights, are unchanged.
 *   * test_runs_claim is replaced: 028's claim fails a waiting run whose
 *     configuration or organization is deleted only through the
 *     configurations join, so a YAML run of a deleted organization would be
 *     claimed and run. It now also fails such a run (organization_deleted)
 *     before it picks, so one is never claimed. Everything else is 028's,
 *     byte for byte.
 *
 * Accepted: test_runs_ahead joins configurations, so it has no
 * row for a YAML run (the public reply has no queue position);
 * test_runs_waiting_for_context_user (migration 029's) counts YAML runs, as
 * the cap of 50 means to.
 *
 * down deletes the YAML runs (their rows only: their files stay in the
 * FileStore, unreachable, as a deleted configuration's runs' do), then
 * restores migration 028's claim, its comment, both policies with their
 * comments and the three columns' comments exactly, drops the check and sets
 * both columns not null again.
 */

const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;
const contextUser = `nullif(current_setting('telflo.user_id', true), '')::uuid`;

/** Migration 021's: a child row of `table` whose configuration the context may see. */
const childVisible = (table) => `organization_id = ${contextOrganization}
        and exists (select 1 from configurations c
                     where c.id = ${table}.configuration_id
                       and c.organization_id = ${table}.organization_id)`;

/** A YAML run (no configuration) of the context's user, in the context's organization. */
const ownYamlRun = `configuration_id is null
        and organization_id = ${contextOrganization}
        and queued_by_user_id = ${contextUser}`;

/** Migration 028's ranking of the waiting runs, shared by the claim and "n ahead", exactly as 028 writes it. */
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

/**
 * test_runs_claim laid out as migration 028 lays it out, with `afterDeletedConfigurations`
 * inserted after the deleted configurations' failure: "" gives 028's source
 * byte for byte.
 */
const claim = (afterDeletedConfigurations) => `
    create or replace function test_runs_claim(p_slots integer, p_lease_overhead_seconds integer)
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
         and (c.deleted_at is not null or o.deleted_at is not null);${afterDeletedConfigurations}
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
`;

/** The YAML runs' own failure: no configuration, so only the organization decides. */
const failDeletedOrganizationsYamlRuns = `
      -- A waiting YAML run (no configuration: the join above never sees it)
      -- of a deleted organization fails here too, rather than runs. Its files
      -- stay.
      update platform.test_runs t
         set status = 'failed',
             finished_at = moment,
             error_code = 'organization_deleted',
             error_message = 'The organization was deleted before the run started.'
        from platform.organizations o
       where t.status = 'queued'
         and t.queued_at <= moment
         and t.configuration_id is null
         and o.id = t.organization_id
         and o.deleted_at is not null;`;

export const up = (pgm) => {
  pgm.sql(`
    alter table test_runs
      alter column configuration_id drop not null,
      alter column configuration_version_id drop not null,
      add constraint ck_test_runs_configuration_together
        check ((configuration_id is null) = (configuration_version_id is null));

    comment on column test_runs.configuration_id is
      'the configuration run, or null for a YAML run (the public API''s run
       of a text with no configuration, its creator''s alone). A run is
       visible to whoever can see its configuration, and hidden once it is
       deleted: the repository hides it, and the claim fails it if it was
       waiting.';
    comment on column test_runs.configuration_version_id is
      'the version whose run list shows the run (fk_test_runs_configuration_version);
       null for a YAML run, which no run list shows.';
    comment on column test_runs.organization_id is
      'the run''s organization: its configuration''s (fk_test_runs_configuration),
       or, for a YAML run, the one its creator queued it in.
       A hard-deleted organization takes its runs.';
    comment on constraint ck_test_runs_configuration_together on test_runs is
      'a run names its configuration and its version, or neither (a YAML run).';

    drop policy test_runs_select on test_runs;
    create policy test_runs_select on test_runs
      for select to telflo_platform_runtime
      using ((${childVisible("test_runs")})
        or (${ownYamlRun}));
    drop policy test_runs_insert on test_runs;
    create policy test_runs_insert on test_runs
      for insert to telflo_platform_runtime
      with check (((${childVisible("test_runs")})
          or (${ownYamlRun}))
        and queued_by_user_id = ${contextUser}
        and status = 'queued'
        and queued_at = now());

    comment on policy test_runs_select on test_runs is
      'the API''s role sees the runs of the configurations the context''s
       user can see (configurations_select applies inside the exists): a
       draft''s runs are its author''s, a published
       configuration''s every member''s, past and future. A deleted
       configuration''s included: the repository hides those.
       And the context''s user''s own YAML runs in the context''s
       organization: no one else''s, an admin''s included.';
    comment on policy test_runs_insert on test_runs is
      'the API''s role queues a run only on a configuration the context''s
       user can see, or with none (a YAML run) in the
       context''s organization, as that user, queued, at now() (a
       backdated run can''t jump the queue); results
       are refused by ck_test_runs_results_only_when_finished. 42501
       otherwise.';
${claim(failDeletedOrganizationsYamlRuns)}
    comment on function test_runs_claim(integer, integer) is
      'the dispatcher''s claim: under an advisory lock, fails each waiting run
       whose configuration or organization is deleted (configuration_deleted),
       and each waiting YAML run whose organization is deleted
       (organization_deleted), then marks running, with a new lease expiring after the run''s duration plus
       p_lease_overhead_seconds, as many waiting runs as p_slots leaves free
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
  `);
};

export const down = (pgm) => {
  pgm.sql(`${claim("")}
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

    drop policy test_runs_insert on test_runs;
    create policy test_runs_insert on test_runs
      for insert to telflo_platform_runtime
      with check (${childVisible("test_runs")}
        and queued_by_user_id = ${contextUser}
        and status = 'queued'
        and queued_at = now());
    drop policy test_runs_select on test_runs;
    create policy test_runs_select on test_runs
      for select to telflo_platform_runtime
      using (${childVisible("test_runs")});

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

    delete from test_runs where configuration_id is null;
    alter table test_runs
      drop constraint ck_test_runs_configuration_together,
      alter column configuration_id set not null,
      alter column configuration_version_id set not null;

    comment on column test_runs.configuration_id is
      'the configuration run. A run is visible to whoever can see it, and
       hidden once it is deleted: the repository hides it, and the claim
       fails it if it was waiting.';
    comment on column test_runs.organization_id is
      'the configuration''s organization (fk_test_runs_configuration). A
       hard-deleted organization takes its runs.';
    comment on column test_runs.configuration_version_id is
      'the version whose run list shows the run (fk_test_runs_configuration_version).';
  `);
};
