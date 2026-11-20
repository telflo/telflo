/**
 * Validation pipelines, their rules, and the runs' new status "Validation
 * Failed".
 *
 *   * validation_pipelines: a configuration version's validation pipelines,
 *     one per version and YAML pipeline (pipeline_name, such as logs/default),
 *     its signal the name's first part, with no name of its own. Created and
 *     deleted, never changed: no rename, no updated_at, and the API's role
 *     updates none, so no identity trigger. A composite foreign key ties it to
 *     its version in its own configuration and organization, on delete
 *     cascade, as test_suites. Row-level security is migration 021's
 *     child-visible rule for select and delete (a draft's are its author's, a
 *     published configuration's every member's); an insert also names the
 *     context's user as its creator.
 *   * validation_rules: a validation pipeline's rules, in their position: the
 *     five kinds (contains_text, not_contains_text, contains_regex,
 *     not_contains_regex, ottl), searched in the output or the collector's log
 *     (an OTTL rule the output only). Text and regex kinds carry a pattern; an
 *     OTTL rule its context, condition, quantifier, count and expression as
 *     columns (not a JSON text). Patterns, conditions and expressions are at
 *     most 8,192 bytes, as the evaluator counts them. The contexts each signal
 *     allows are the API's and the evaluator's check, not the database's: the
 *     seven names only. A composite foreign key ties a rule to a pipeline of
 *     its own version, configuration and organization, on delete cascade, so
 *     it can't name another's (no member inserts a rule into a pipeline only
 *     by knowing its id). position is unique per pipeline, the next one
 *     max + 1 under the configuration's row lock. Row-level security: the
 *     child-visible rule for select, update and delete, and for an insert
 *     naming the context's user as its creator. A trigger,
 *     validation_rules_identity_unchanged, keeps a rule's id, organization,
 *     configuration, version, pipeline, position and created_at, and lets its
 *     creator change only to null; its kind, target, pattern, OTTL, name and
 *     description may change (the editor switches modes).
 *   * test_runs gains the status validation_failed (the collector ran and at
 *     least one rule failed), the move running → validation_failed, the rules'
 *     snapshot (validation_pipeline_id, no foreign key, as source_run_id;
 *     validation_rules, '[]' for none, at most 200, each an object with a
 *     string id, frozen by the guard) and the result column validation_results
 *     (null until finished, then one result per rule, each an object with a
 *     string id and a boolean passed). ck_test_runs_validation_outcome ties
 *     the status to the results (a validation_failed run has no error code and
 *     a failed rule; a succeeded run has no rules, or no failed result). The
 *     guard, refuse_test_run_change(), is replaced from migration 029's text
 *     with the two snapshot columns and the new move. test_runs_finish takes
 *     the run's final status (succeeded, failed or validation_failed) in place
 *     of whether it succeeded, and fills validation_results; the boolean one
 *     is dropped, so no call is ambiguous.
 *   * test_runs_rules(run, lease): the dispatcher's read of a running run's
 *     snapshot while that lease holds it. The claim is unchanged.
 *   * ottl_evaluator_state and ottl_evaluator_mark(up): the evaluator's health
 *     as every API process sees it, copied from migration 028's
 *     otelcol_testing_state and otelcol_testing_mark. Global; the API's role
 *     reads it and writes it only through the function.
 *
 * Migration 009's default privileges give telflo_platform_runtime select,
 * insert, update and delete on the three tables; ottl_evaluator_state's
 * insert, update and delete are revoked. The three new functions are
 * SECURITY DEFINER, EXECUTE for telflo_platform_runtime only, refusing (42501)
 * outside the dispatcher's context, as migration 028's.
 *
 * down refuses while any run is validation_failed (migration 028's status
 * check couldn't be put back over it), as the federated-identity
 * migration's down refuses; otherwise it restores migration 029's
 * refuse_test_run_change() and migration 028's test_runs_finish (boolean)
 * byte for byte with their comments and grants, puts back the three checks
 * and the status column's comment as 028 wrote them, drops the three
 * columns with their checks, and drops the three tables, the two new
 * functions and the trigger's function: exactly what up added.
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

/** Migration 029's breadcrumb, in the snapshot too. */
const breadcrumbColumns = ["test_suite_id", "test_suite_name", "test_definition_id", "test_definition_name"];

/** This migration's: the rules' snapshot, taken when the run is queued. */
const validationSnapshotColumns = ["validation_pipeline_id", "validation_rules"];

/** Migration 028's result columns, which test_runs_finish fills; null until the run finishes. */
const resultColumns028 = [
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

/** This migration's result columns: 028's and the rules' results. */
const resultColumns030 = [...resultColumns028, "validation_results"];

/** Migration 028's finished statuses, and this migration's. */
const finishedStatuses028 = ["succeeded", "failed"];
const finishedStatuses030 = ["succeeded", "failed", "validation_failed"];

/** The seven OTTL contexts' names; which a signal allows is the API's and the evaluator's check. */
const ottlContexts = ["log", "span", "spanevent", "metric", "datapoint", "resource", "scope"];

const quoted = (values) => values.map((value) => `'${value}'`).join(", ");

/**
 * Migration 029's refuse_test_run_change(), over `columns`, with the
 * statuses a running run may go to as `fromRunning`, laid out as 029 lays it
 * out: with 029's columns and ('succeeded', 'failed', 'queued'), its source
 * is 029's byte for byte, which schema.integration.test.ts checks.
 */
const runGuard = (columns, fromRunning) => `
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
              or (old.status = 'running' and new.status in (${quoted(fromRunning)})))
      then
        raise exception 'test run % can''t go from % to %', old.id, old.status, new.status;
      end if;
      return new;
    end;
    $$;
`;

/** Migration 028's test_runs_finish, laid out as 028 lays it out: its source is 028's byte for byte. */
const finish028 = `
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
                  where k not in (${quoted(resultColumns028)})) then
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
`;

/** This migration's test_runs_finish: the final status in place of a boolean, and the rules' results. */
const finish030 = `
    create function test_runs_finish(p_run_id uuid, p_lease_id uuid, p_status text, p_results jsonb)
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
      if p_status is null or p_status not in (${quoted(finishedStatuses030)})
         or p_results is null or jsonb_typeof(p_results) <> 'object' then
        raise exception 'a finish takes the run''s final status (succeeded, failed or validation_failed) and its results as an object'
          using errcode = 'invalid_parameter_value';
      end if;
      if exists (select 1 from jsonb_object_keys(p_results) k
                  where k not in (${quoted(resultColumns030)})) then
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
         set status = p_status,
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
             error_message = p_results ->> 'error_message',
             validation_results = nullif(p_results -> 'validation_results', 'null'::jsonb)
       where t.id = p_run_id
         and t.status = 'running'
         and t.lease_id = p_lease_id;
      get diagnostics finished = row_count;
      return finished = 1;
    end;
    $$;
`;

/** ck_test_runs_status over `statuses`, as migration 028 wrote it. */
const statusCheck = (statuses) => `check (status in (${quoted(statuses)}))`;

/** ck_test_runs_state with `finished` the finished statuses, as migration 028 wrote it. */
const stateCheck = (finished) => `check (
        (status = 'queued'
          and started_at is null and finished_at is null and lease_id is null and lease_expires_at is null)
        or (status = 'running'
          and started_at is not null and finished_at is null and lease_id is not null and lease_expires_at is not null)
        or (status in (${quoted(finished)})
          and finished_at is not null and lease_id is null and lease_expires_at is null))`;

/** ck_test_runs_results_only_when_finished over `finished` and `columns`, as migration 028 wrote it. */
const resultsCheck = (finished, columns) => `check (
        status in (${quoted(finished)})
        or (${columns.map((column) => `${column} is null`).join(" and ")}))`;

/**
 * The characters a blank pattern, condition or expression holds nothing but:
 * ASCII's whitespace (space, tab, newline, vertical tab, form feed, return).
 * Unicode's is the API's and the evaluator's check.
 */
const blank = `E' \\t\\n\\x0B\\f\\r'`;

/** Every function this migration grants, with its arguments. */
const grantedFunctions = [
  "test_runs_finish(uuid, uuid, text, jsonb)",
  "test_runs_rules(uuid, uuid)",
  "ottl_evaluator_mark(boolean)",
];

export const up = (pgm) => {
  pgm.sql(`
    create table validation_pipelines (
      id                        uuid         primary key default uuidv7(),
      organization_id           uuid         not null references organizations(id) on delete cascade,
      configuration_id          uuid         not null,
      configuration_version_id  uuid         not null,
      pipeline_name             text         not null,
      signal                    text         not null,
      created_by_user_id        uuid         references users(id) on delete set null,
      created_at                timestamptz  not null,
      constraint fk_validation_pipelines_configuration_version
        foreign key (configuration_version_id, configuration_id, organization_id)
        references configuration_versions (id, configuration_id, organization_id) on delete cascade,
      constraint uq_validation_pipelines_version_pipeline_name
        unique (configuration_version_id, pipeline_name),
      constraint uq_validation_pipelines_id_version_configuration_organization
        unique (id, configuration_version_id, configuration_id, organization_id),
      constraint ck_validation_pipelines_pipeline_name_length
        check (char_length(pipeline_name) between 1 and 200),
      constraint ck_validation_pipelines_signal check (signal in ('traces', 'metrics', 'logs')),
      constraint ck_validation_pipelines_pipeline_signal check (split_part(pipeline_name, '/', 1) = signal)
    );

    comment on table validation_pipelines is
      'a configuration version''s validation pipelines: one per YAML pipeline
       (logs/default), holding its rules, which a run of that pipeline copies
       when it is queued. Visible to whoever can see its configuration: a
       draft''s are its author''s, a published configuration''s every
       member''s, who may create and delete them on any version. Created and
       deleted, never changed. A new version copies its source''s. No cap per
       version.';
    comment on column validation_pipelines.id is
      'the validation pipeline''s id (uuidv7). A version copy takes a new one
       per pipeline, in the source''s order, so (created_at, id) keeps that
       order.';
    comment on column validation_pipelines.organization_id is
      'the configuration''s organization
       (fk_validation_pipelines_configuration_version). A hard-deleted
       organization takes its validation pipelines.';
    comment on column validation_pipelines.configuration_id is
      'the configuration whose visibility the validation pipeline follows.';
    comment on column validation_pipelines.configuration_version_id is
      'the version the validation pipeline belongs to
       (fk_validation_pipelines_configuration_version).';
    comment on column validation_pipelines.pipeline_name is
      'the YAML pipeline it validates, as the text names it (logs,
       logs/default), 1 to 200 characters; one validation pipeline per
       version and name (uq_validation_pipelines_version_pipeline_name). Its
       name may have left the text since (the editor warns). Configuration
       text.';
    comment on column validation_pipelines.signal is
      'the pipeline''s signal: traces, metrics or logs, the name''s first part
       (ck_validation_pipelines_pipeline_signal). Its rules'' OTTL contexts
       follow it.';
    comment on column validation_pipelines.created_by_user_id is
      'the member who created it, or who created the version whose copy it
       is: the insert policy admits only the context''s user.
       Null once their account is hard-deleted.';
    comment on column validation_pipelines.created_at is
      'written by the API from its clock, never now(), as test_suites''; a
       version copy writes the version''s time. The list''s order, with the
       id.';

    comment on constraint validation_pipelines_pkey on validation_pipelines is
      'one row per validation pipeline, by its id.';
    comment on constraint validation_pipelines_organization_id_fkey on validation_pipelines is
      'the validation pipeline''s organization (23503 otherwise); on delete
       cascade.';
    comment on constraint validation_pipelines_created_by_user_id_fkey on validation_pipelines is
      'the validation pipeline''s creator (23503 otherwise); on delete set
       null.';
    comment on constraint fk_validation_pipelines_configuration_version on validation_pipelines is
      'a validation pipeline names a version of its own configuration in its
       own organization (23503 otherwise). On delete cascade: a version goes
       only with its configuration, which the API never hard-deletes
       (migration 022), so only an operator''s or an organization''s hard
       delete reaches it.';
    comment on constraint uq_validation_pipelines_version_pipeline_name on validation_pipelines is
      'one validation pipeline per version and YAML pipeline (23505; the API
       answers validation_pipeline_exists). Led by the version, it also serves
       fk_validation_pipelines_configuration_version''s cascade and a
       version''s list.';
    comment on constraint uq_validation_pipelines_id_version_configuration_organization on validation_pipelines is
      'the target of fk_validation_rules_validation_pipeline: a rule names a
       validation pipeline of its own version, configuration and
       organization.';
    comment on constraint ck_validation_pipelines_pipeline_name_length on validation_pipelines is
      'the pipeline''s name is 1 to 200 characters, as a run''s.';
    comment on constraint ck_validation_pipelines_signal on validation_pipelines is
      'traces, metrics or logs.';
    comment on constraint ck_validation_pipelines_pipeline_signal on validation_pipelines is
      'the pipeline''s name begins with its signal (logs, logs/default).';

    create index idx_validation_pipelines_organization_configuration
      on validation_pipelines (organization_id, configuration_id);
    create index idx_validation_pipelines_created_by_user_id
      on validation_pipelines (created_by_user_id);

    comment on index idx_validation_pipelines_organization_configuration is
      'a configuration''s validation pipelines, and an organization''s
       cascade.';
    comment on index idx_validation_pipelines_created_by_user_id is
      'a hard-deleted account''s set null; without an index that would scan
       the table.';

    alter table validation_pipelines enable row level security;

    create policy validation_pipelines_select on validation_pipelines
      for select to telflo_platform_runtime
      using (${childVisible("validation_pipelines")});
    create policy validation_pipelines_insert on validation_pipelines
      for insert to telflo_platform_runtime
      with check (${childVisible("validation_pipelines")}
        and created_by_user_id = ${contextUser});
    create policy validation_pipelines_update on validation_pipelines
      for update to telflo_platform_runtime
      using (false);
    create policy validation_pipelines_delete on validation_pipelines
      for delete to telflo_platform_runtime
      using (${childVisible("validation_pipelines")});

    comment on policy validation_pipelines_select on validation_pipelines is
      'the API''s role sees the validation pipelines of the configurations
       the context''s user can see (configurations_select applies inside the
       exists): a draft''s are its author''s, a published
       configuration''s every member''s.';
    comment on policy validation_pipelines_insert on validation_pipelines is
      'the API''s role adds a validation pipeline only to a configuration the
       context''s user can see, as that user (42501 otherwise).';
    comment on policy validation_pipelines_update on validation_pipelines is
      'a validation pipeline never changes: the API''s
       role updates none, and so locks none with FOR UPDATE.';
    comment on policy validation_pipelines_delete on validation_pipelines is
      'the API''s role deletes only the validation pipelines it can see; their
       rules go with them (fk_validation_rules_validation_pipeline).';

    create table validation_rules (
      id                        uuid         primary key default uuidv7(),
      organization_id           uuid         not null references organizations(id) on delete cascade,
      configuration_id          uuid         not null,
      configuration_version_id  uuid         not null,
      validation_pipeline_id    uuid         not null,
      position                  integer      not null,
      kind                      text         not null,
      target                    text         not null,
      pattern                   text,
      ottl_context              text,
      ottl_condition            text,
      ottl_quantifier           text,
      ottl_count_operator       text,
      ottl_count_value          integer,
      ottl_count_value2         integer,
      ottl_expression           text,
      name                      text         not null default '',
      description               text         not null default '',
      created_by_user_id        uuid         references users(id) on delete set null,
      created_at                timestamptz  not null,
      updated_at                timestamptz  not null,
      constraint fk_validation_rules_validation_pipeline
        foreign key (validation_pipeline_id, configuration_version_id, configuration_id, organization_id)
        references validation_pipelines (id, configuration_version_id, configuration_id, organization_id)
        on delete cascade,
      constraint uq_validation_rules_pipeline_position unique (validation_pipeline_id, position),
      constraint ck_validation_rules_position check (position >= 1),
      constraint ck_validation_rules_kind
        check (kind in ('contains_text', 'not_contains_text', 'contains_regex', 'not_contains_regex', 'ottl')),
      constraint ck_validation_rules_target check (target in ('output', 'stderr')),
      constraint ck_validation_rules_ottl_output_only check (kind <> 'ottl' or target = 'output'),
      constraint ck_validation_rules_pattern_only_text_and_regex check ((kind = 'ottl') = (pattern is null)),
      constraint ck_validation_rules_pattern_length
        check (pattern is null or (octet_length(pattern) <= 8192 and btrim(pattern, ${blank}) <> '')),
      constraint ck_validation_rules_ottl_only_ottl
        check ((kind = 'ottl') = (ottl_context is not null and ottl_quantifier is not null)
               and (kind = 'ottl'
                    or num_nonnulls(ottl_context, ottl_condition, ottl_quantifier, ottl_count_operator,
                                    ottl_count_value, ottl_count_value2, ottl_expression) = 0)),
      constraint ck_validation_rules_ottl_context check (ottl_context in (${quoted(ottlContexts)})),
      constraint ck_validation_rules_ottl_quantifier
        check (ottl_quantifier in ('all', 'any', 'none', 'count', 'distinct')),
      constraint ck_validation_rules_ottl_shape check (
        ottl_quantifier is null
        or (ottl_quantifier in ('all', 'any', 'none')
            and ottl_condition is not null and ottl_count_operator is null and ottl_expression is null)
        or (ottl_quantifier = 'count'
            and ottl_condition is not null and ottl_count_operator is not null and ottl_expression is null)
        or (ottl_quantifier = 'distinct'
            and ottl_expression is not null and ottl_count_operator is not null)),
      constraint ck_validation_rules_ottl_count check (
        (ottl_count_operator is null and ottl_count_value is null and ottl_count_value2 is null)
        or (ottl_count_operator is not null and ottl_count_operator in ('eq', 'ne', 'gt', 'gte', 'lt', 'lte')
            and ottl_count_value is not null and ottl_count_value >= 0 and ottl_count_value2 is null)
        or (ottl_count_operator is not null and ottl_count_operator = 'between'
            and ottl_count_value is not null and ottl_count_value2 is not null
            and ottl_count_value >= 0 and ottl_count_value2 >= ottl_count_value)),
      constraint ck_validation_rules_ottl_condition_length
        check (ottl_condition is null
               or (octet_length(ottl_condition) <= 8192 and btrim(ottl_condition, ${blank}) <> '')),
      constraint ck_validation_rules_ottl_expression_length
        check (ottl_expression is null
               or (octet_length(ottl_expression) <= 8192 and btrim(ottl_expression, ${blank}) <> '')),
      constraint ck_validation_rules_name_trimmed check (name = btrim(name)),
      constraint ck_validation_rules_name_length check (char_length(name) <= 200),
      constraint ck_validation_rules_description_length check (char_length(description) <= 2000)
    );

    comment on table validation_rules is
      'a validation pipeline''s rules, in their position: text and regex
       rules over the output or the collector''s log, and OTTL rules over the
       output''s records. A run copies them when it is queued; the API checks
       each OTTL and regex rule with the evaluator before it is stored.
       Visible to whoever can see its configuration, who may add, change and
       delete them on any version. At most 200 per validation pipeline, which
       the API counts under the configuration''s lock.';
    comment on column validation_rules.id is
      'the rule''s id (uuidv7); a run''s results name it.';
    comment on column validation_rules.organization_id is
      'the configuration''s organization (fk_validation_rules_validation_pipeline).';
    comment on column validation_rules.configuration_id is
      'the configuration whose visibility the rule follows.';
    comment on column validation_rules.configuration_version_id is
      'the validation pipeline''s version (fk_validation_rules_validation_pipeline).';
    comment on column validation_rules.validation_pipeline_id is
      'the validation pipeline it belongs to, in the same version
       (fk_validation_rules_validation_pipeline); it goes with it, and never
       moves (validation_rules_identity_unchanged).';
    comment on column validation_rules.position is
      'its place in its validation pipeline, from 1, unique there
       (uq_validation_rules_pipeline_position): a new rule takes the largest
       plus one under the configuration''s row lock, so
       gaps after deletes stay. Never changed (no reorder).';
    comment on column validation_rules.kind is
      'contains_text, not_contains_text, contains_regex, not_contains_regex
       or ottl.';
    comment on column validation_rules.target is
      'what a text or regex rule searches: output (the stored output, compact
       JSON) or stderr (the collector''s log). An OTTL rule reads the output
       only.';
    comment on column validation_rules.pattern is
      'a text or regex rule''s text or pattern, not blank, at most 8,192 bytes
       (the evaluator''s cap); null for an OTTL rule. A
       regex parses as Go''s RE2, which the API checks before storing it.
       Configuration text.';
    comment on column validation_rules.ottl_context is
      'an OTTL rule''s context: one of the seven names; which the pipeline''s
       signal allows (logs: log, resource, scope; traces: span, spanevent,
       resource, scope; metrics: metric, datapoint, resource, scope) the API
       and the evaluator check. Null for other kinds.';
    comment on column validation_rules.ottl_condition is
      'an OTTL rule''s condition, not blank, at most 8,192 bytes; the
       quantifiers all, any, none and count need it, distinct may filter by
       it. It parses with the evaluator''s converters-only parser, which the
       API checks before storing it. Configuration text.';
    comment on column validation_rules.ottl_quantifier is
      'an OTTL rule''s quantifier: all, any, none, count or distinct.';
    comment on column validation_rules.ottl_count_operator is
      'count''s and distinct''s comparison: eq, ne, gt, gte, lt, lte or
       between; null for all, any and none.';
    comment on column validation_rules.ottl_count_value is
      'the comparison''s value, never negative; between''s lower bound.';
    comment on column validation_rules.ottl_count_value2 is
      'between''s upper bound, at least its lower; null otherwise.';
    comment on column validation_rules.ottl_expression is
      'distinct''s value expression, not blank, at most 8,192 bytes; null
       otherwise. Configuration text.';
    comment on column validation_rules.name is
      'trimmed, at most 200 characters; the empty string when there is none.
       Configuration text.';
    comment on column validation_rules.description is
      'at most 2,000 characters; the empty string when there is none.
       Configuration text.';
    comment on column validation_rules.created_by_user_id is
      'the member who added it, or who created the version whose copy it is:
       the insert policy admits only the context''s user. Null once their
       account is hard-deleted; never changed otherwise.';
    comment on column validation_rules.created_at is
      'written by the API from its clock; a version copy writes the
       version''s time.';
    comment on column validation_rules.updated_at is
      'written by the API from its clock on create and on every change.';

    comment on constraint validation_rules_pkey on validation_rules is
      'one row per rule, by its id.';
    comment on constraint validation_rules_organization_id_fkey on validation_rules is
      'the rule''s organization (23503 otherwise); on delete cascade.';
    comment on constraint validation_rules_created_by_user_id_fkey on validation_rules is
      'the rule''s creator (23503 otherwise); on delete set null, which the
       identity trigger allows.';
    comment on constraint fk_validation_rules_validation_pipeline on validation_rules is
      'a rule names a validation pipeline of its own version, configuration
       and organization (23503 otherwise), so it can''t name another
       version''s or organization''s. On delete cascade:
       a validation pipeline''s rules go with it.';
    comment on constraint uq_validation_rules_pipeline_position on validation_rules is
      'one rule per place in a validation pipeline: the backstop behind the
       API''s max + 1 under the configuration''s lock. Led by the validation
       pipeline, it also serves the list in order and
       fk_validation_rules_validation_pipeline''s cascade.';
    comment on constraint ck_validation_rules_position on validation_rules is
      'a place counts from 1.';
    comment on constraint ck_validation_rules_kind on validation_rules is
      'contains_text, not_contains_text, contains_regex, not_contains_regex or
       ottl.';
    comment on constraint ck_validation_rules_target on validation_rules is
      'output or stderr.';
    comment on constraint ck_validation_rules_ottl_output_only on validation_rules is
      'an OTTL rule reads the output''s records, never the collector''s log.';
    comment on constraint ck_validation_rules_pattern_only_text_and_regex on validation_rules is
      'a text or regex rule has a pattern, an OTTL rule none.';
    comment on constraint ck_validation_rules_pattern_length on validation_rules is
      'a pattern is at most 8,192 bytes (octet_length, as the evaluator
       counts), and not blank.';
    comment on constraint ck_validation_rules_ottl_only_ottl on validation_rules is
      'an OTTL rule has its context and quantifier; any other kind has no OTTL
       column at all.';
    comment on constraint ck_validation_rules_ottl_context on validation_rules is
      'one of the seven OTTL contexts'' names; the signal''s are the API''s
       check.';
    comment on constraint ck_validation_rules_ottl_quantifier on validation_rules is
      'all, any, none, count or distinct.';
    comment on constraint ck_validation_rules_ottl_shape on validation_rules is
      'all, any and none take a condition and no count; count a condition and
       a count; distinct an expression and a count (its condition optional).';
    comment on constraint ck_validation_rules_ottl_count on validation_rules is
      'a count is an operator with its value, never negative, and between''s
       two bounds in order, or nothing at all. Every branch says is not
       null of what it compares: a check passes on null, so a value without
       its operator, or between without a bound, would slip through.';
    comment on constraint ck_validation_rules_ottl_condition_length on validation_rules is
      'a condition is at most 8,192 bytes, and not blank.';
    comment on constraint ck_validation_rules_ottl_expression_length on validation_rules is
      'an expression is at most 8,192 bytes, and not blank.';
    comment on constraint ck_validation_rules_name_trimmed on validation_rules is
      'the name is trimmed, which the API''s contract does first.';
    comment on constraint ck_validation_rules_name_length on validation_rules is
      'the name is at most 200 characters.';
    comment on constraint ck_validation_rules_description_length on validation_rules is
      'the description is at most 2,000 characters.';

    create index idx_validation_rules_organization_configuration
      on validation_rules (organization_id, configuration_id);
    create index idx_validation_rules_created_by_user_id
      on validation_rules (created_by_user_id);

    comment on index idx_validation_rules_organization_configuration is
      'a configuration''s rules, and an organization''s cascade.';
    comment on index idx_validation_rules_created_by_user_id is
      'a hard-deleted account''s set null; without an index that would scan
       the table.';

    alter table validation_rules enable row level security;

    create policy validation_rules_select on validation_rules
      for select to telflo_platform_runtime
      using (${childVisible("validation_rules")});
    create policy validation_rules_insert on validation_rules
      for insert to telflo_platform_runtime
      with check (${childVisible("validation_rules")}
        and created_by_user_id = ${contextUser});
    create policy validation_rules_update on validation_rules
      for update to telflo_platform_runtime
      using (${childVisible("validation_rules")})
      with check (${childVisible("validation_rules")});
    create policy validation_rules_delete on validation_rules
      for delete to telflo_platform_runtime
      using (${childVisible("validation_rules")});

    comment on policy validation_rules_select on validation_rules is
      'the API''s role sees the rules of the configurations the context''s
       user can see: a draft''s are its author''s, a
       published configuration''s every member''s.';
    comment on policy validation_rules_insert on validation_rules is
      'the API''s role adds a rule only to a configuration the context''s user
       can see, as that user (42501 otherwise): its creator can''t be forged,
       and fk_validation_rules_validation_pipeline keeps it in a pipeline of
       its own version.';
    comment on policy validation_rules_update on validation_rules is
      'the API''s role changes only the rules it can see, on any version, and
       keeps them visible; the identity trigger keeps them
       in their pipeline and place.';
    comment on policy validation_rules_delete on validation_rules is
      'the API''s role deletes only the rules it can see.';

    -- Not SECURITY DEFINER: it reads only the row it is given, as whatever
    -- role runs the update. P0001 (raise_exception), as migration 029's
    -- trigger raises, with a message naming only the rule's id.
    create function refuse_validation_rule_identity_change() returns trigger
    language plpgsql
    set search_path = pg_catalog, platform
    as $$
    begin
      if (new.id, new.organization_id, new.configuration_id, new.configuration_version_id,
          new.validation_pipeline_id, new.position, new.created_at)
           is distinct from
         (old.id, old.organization_id, old.configuration_id, old.configuration_version_id,
          old.validation_pipeline_id, old.position, old.created_at)
         or (new.created_by_user_id is distinct from old.created_by_user_id
             and new.created_by_user_id is not null)
      then
        raise exception 'validation rule % keeps its pipeline, its place and its creator', old.id;
      end if;
      return new;
    end;
    $$;

    create trigger validation_rules_identity_unchanged
      before update on validation_rules
      for each row execute function refuse_validation_rule_identity_change();

    comment on function refuse_validation_rule_identity_change() is
      'a rule keeps its identity, kept by the database
       for every role: its id, organization, configuration, version,
       validation pipeline, position and created_at never change, so a rule
       can''t move to another pipeline, version or organization, and its
       creator changes only to null (the users foreign key''s on delete set
       null). Its kind, target, pattern, OTTL columns, name and description
       may change (the editor switches modes). P0001, naming only the
       rule''s id. A same-value write passes. Not SECURITY DEFINER: it reads
       only the row it is given.';
    comment on trigger validation_rules_identity_unchanged on validation_rules is
      'before update, for every role on a plain UPDATE, the API''s and the
       tables'' owner alike. Only an operator can bypass it (ALTER TABLE …
       DISABLE TRIGGER, session_replication_role = replica).';

    alter table test_runs
      add column validation_pipeline_id  uuid,
      add column validation_rules        jsonb  not null default '[]',
      add column validation_results      jsonb,
      add constraint ck_test_runs_validation_rules
        check (jsonb_typeof(validation_rules) = 'array' and jsonb_array_length(validation_rules) <= 200
               and not validation_rules @? 'strict $[*] ? (@.type() != "object")'
               and not validation_rules @? 'lax $[*] ? (!(@.id.type() == "string"))'),
      add constraint ck_test_runs_validation_results
        check (validation_results is null
               or (jsonb_typeof(validation_results) = 'array'
                   and jsonb_array_length(validation_results) = jsonb_array_length(validation_rules)
                   and not validation_results @? 'strict $[*] ? (@.type() != "object")'
                   and not validation_results @? 'lax $[*] ? (!(@.id.type() == "string" && @.passed.type() == "boolean"))')),
      add constraint ck_test_runs_validation_outcome
        check ((status <> 'validation_failed'
                or (error_code is null and validation_results is not null
                    and jsonb_path_exists(validation_results, '$[*] ? (@.passed == false)')))
               and (status <> 'succeeded'
                    or (jsonb_array_length(validation_rules) = 0 and validation_results is null)
                    or (validation_results is not null
                        and not jsonb_path_exists(validation_results, '$[*] ? (@.passed == false)')))),
      drop constraint ck_test_runs_status,
      add constraint ck_test_runs_status ${statusCheck(["queued", "running", ...finishedStatuses030])},
      drop constraint ck_test_runs_state,
      add constraint ck_test_runs_state ${stateCheck(finishedStatuses030)},
      drop constraint ck_test_runs_results_only_when_finished,
      add constraint ck_test_runs_results_only_when_finished ${resultsCheck(finishedStatuses030, resultColumns030)};

    comment on column test_runs.status is
      'queued, running, succeeded, failed or validation_failed. queued →
       running (claimed) → succeeded, failed or validation_failed (finished,
       reaped), queued → failed (the tester down, the configuration deleted),
       and running → queued (released when the tester refused before
       starting). Nothing else: the guard trigger. validation_failed
       ("Validation Failed"): the collector ran and at least one
       of the run''s rules failed.';
    comment on column test_runs.validation_pipeline_id is
      'the validation pipeline whose rules the run copied when it was queued,
       the one of its version named by its pipeline; null when there was
       none. No foreign key, as source_run_id: the
       pipeline may be deleted, and the run keeps its snapshot.';
    comment on column test_runs.validation_rules is
      'the rules the run checks, copied in position order when it was queued
       and frozen there (the guard trigger): a rule edited later doesn''t
       change it, a re-run copies the current ones. A
       JSON array of at most 200; [] when there are none. Configuration text.';
    comment on column test_runs.validation_results is
      'the rules'' results, one per rule of validation_rules in its order,
       each with passed, its error and its details,
       written by test_runs_finish; null until the run finishes, and on a run
       whose rules weren''t checked. Snippets and samples are configuration
       text.';
    comment on constraint ck_test_runs_status on test_runs is
      'queued, running, succeeded, failed or validation_failed.';
    comment on constraint ck_test_runs_state on test_runs is
      'the times and the lease follow the status: a queued run has neither
       started nor finished nor a lease; a running run has started and holds
       a lease; a finished run (succeeded, failed or validation_failed) has
       finished and holds no lease.';
    comment on constraint ck_test_runs_results_only_when_finished on test_runs is
      'results (the tester''s answer, the rules'' results, an error) only on a
       succeeded, failed or validation_failed run: a queued or running one has
       none, so a member''s insert carries none.';
    comment on constraint ck_test_runs_validation_rules on test_runs is
      'the rules'' snapshot is a JSON array of at most 200, a validation
       pipeline''s cap, each rule an object with a string id.';
    comment on constraint ck_test_runs_validation_results on test_runs is
      'the rules'' results are null, or a JSON array with one result per rule,
       each an object with a string id and a boolean passed, so
       ck_test_runs_validation_outcome reads a real passed: a string
       "false" is refused, not taken for a pass.';
    comment on constraint ck_test_runs_validation_outcome on test_runs is
      'the status follows the rules'' results: a
       validation_failed run has no error code and its results, at least one
       with passed false; a succeeded run has no rules and no results, or
       results none of which failed. A failed run may have either.';
${runGuard([...snapshotColumns028, ...breadcrumbColumns, ...validationSnapshotColumns], [...finishedStatuses030, "queued"])}
    comment on function refuse_test_run_change() is
      'the run''s rules, kept by the database for every role: its snapshot
       and identity, the breadcrumb (test_suite_id,
       test_suite_name, test_definition_id, test_definition_name) and the
       rules'' snapshot (validation_pipeline_id, validation_rules) included,
       never change, and queued_by_user_id only to null (the users foreign
       key''s on delete set null); its status goes only queued → running or
       failed, and running → succeeded, failed, validation_failed or queued
       (release); and a run that keeps its status changes in nothing else, so
       a finished run never changes. P0001, naming only the run''s id. Not
       SECURITY DEFINER: it reads only the row it is given.';

    drop function test_runs_finish(uuid, uuid, boolean, jsonb);
${finish030}
    comment on function test_runs_finish(uuid, uuid, text, jsonb) is
      'finishes a running run whose lease is p_lease_id: p_status is its
       final status,
       succeeded, failed or validation_failed (22023 for any other), with the
       results, a JSON object whose keys name result columns, the rules''
       validation_results among them (22023 for any other). True when it did;
       false when the run is no longer the caller''s (reaped, or finished
       already), and then nothing changes. The dispatcher only (42501).';

    create function test_runs_rules(p_run_id uuid, p_lease_id uuid)
    returns jsonb
    language plpgsql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      rules jsonb;
    begin
      perform platform.test_runs_require_dispatcher();
      select t.validation_rules into rules
        from platform.test_runs t
       where t.id = p_run_id
         and t.status = 'running'
         and t.lease_id = p_lease_id;
      return rules;
    end;
    $$;

    comment on function test_runs_rules(uuid, uuid) is
      'the rules'' snapshot of a running run whose lease is p_lease_id, which
       the dispatcher has checked once the
       tester answers: a JSON array, [] for none; null when the run is no
       longer the caller''s (reaped, or finished). The claim doesn''t carry
       it. The dispatcher only (42501).';

    create table ottl_evaluator_state (
      id          boolean      primary key default true,
      down_since  timestamptz,
      constraint ck_ottl_evaluator_state_singleton check (id)
    );

    insert into ottl_evaluator_state default values;

    revoke insert, update, delete on ottl_evaluator_state from telflo_platform_runtime;

    comment on table ottl_evaluator_state is
      'the OTTL evaluator''s health as every API process sees it: one row, as
       otelcol_testing_state. Global: the evaluator serves every organization.
       The API''s role reads it (queuing refuses a run with rules while it is
       down) and changes it only through ottl_evaluator_mark.';
    comment on column ottl_evaluator_state.id is
      'always true: the table holds one row (ck_ottl_evaluator_state_singleton).';
    comment on column ottl_evaluator_state.down_since is
      'when a health monitor counted the evaluator down (its second failed
       check in a row), on the database''s clock; null while it is up.';
    comment on constraint ottl_evaluator_state_pkey on ottl_evaluator_state is
      'the row''s key, always true.';
    comment on constraint ck_ottl_evaluator_state_singleton on ottl_evaluator_state is
      'one row only: its key is true.';

    create function ottl_evaluator_mark(p_up boolean)
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
        raise exception 'the evaluator is marked up or down' using errcode = 'invalid_parameter_value';
      end if;
      -- The row first, then the time.
      perform 1 from platform.ottl_evaluator_state s for update;
      moment := clock_timestamp();
      update platform.ottl_evaluator_state s
         set down_since = case when p_up then null else coalesce(s.down_since, moment) end
      returning s.down_since into since;
      return since;
    end;
    $$;

    comment on function ottl_evaluator_mark(boolean) is
      'a health monitor''s change (as otelcol_testing_mark): up clears
       down_since; down sets it to the clock, read after the row''s lock,
       unless it is set already, so it keeps the first process''s time. Returns
       down_since as it is now. The dispatcher only (42501).';

    revoke execute on function ${grantedFunctions.join(", ")} from public;
    grant execute on function ${grantedFunctions.join(", ")} to telflo_platform_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    do $$
    declare
      refused bigint;
    begin
      select count(*) into refused
        from test_runs
       where status = 'validation_failed';
      if refused > 0 then
        raise exception
          'cannot restore migration 029''s run statuses: % run(s) ended validation_failed',
          refused
          using errcode = 'check_violation';
      end if;
    end
    $$;

    drop function ottl_evaluator_mark(boolean);
    drop table ottl_evaluator_state;
    drop function test_runs_rules(uuid, uuid);

    drop function test_runs_finish(uuid, uuid, text, jsonb);
${finish028}
    comment on function test_runs_finish(uuid, uuid, boolean, jsonb) is
      'finishes a running run whose lease is p_lease_id: succeeded or failed,
       with the results, a JSON object whose
       keys name result columns (22023 for any other). True when it did;
       false when the run is no longer the caller''s (reaped, or finished
       already), and then nothing changes. The dispatcher only (42501).';
    revoke execute on function test_runs_finish(uuid, uuid, boolean, jsonb) from public;
    grant execute on function test_runs_finish(uuid, uuid, boolean, jsonb) to telflo_platform_runtime;
${runGuard([...snapshotColumns028, ...breadcrumbColumns], [...finishedStatuses028, "queued"])}
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

    alter table test_runs
      drop constraint ck_test_runs_results_only_when_finished,
      drop constraint ck_test_runs_state,
      drop constraint ck_test_runs_status,
      drop constraint ck_test_runs_validation_outcome,
      drop constraint ck_test_runs_validation_results,
      drop constraint ck_test_runs_validation_rules,
      drop column validation_results,
      drop column validation_rules,
      drop column validation_pipeline_id,
      add constraint ck_test_runs_status ${statusCheck(["queued", "running", ...finishedStatuses028])},
      add constraint ck_test_runs_state ${stateCheck(finishedStatuses028)},
      add constraint ck_test_runs_results_only_when_finished ${resultsCheck(finishedStatuses028, resultColumns028)};

    comment on column test_runs.status is
      'queued, running, succeeded or failed. queued → running (claimed) →
       succeeded or failed (finished, reaped), queued → failed (the tester
       down, the configuration deleted), and running → queued (released when
       the tester refused before starting). Nothing else: the guard trigger.';
    comment on constraint ck_test_runs_status on test_runs is
      'queued, running, succeeded or failed.';
    comment on constraint ck_test_runs_state on test_runs is
      'the times and the lease follow the status: a queued run has neither
       started nor finished nor a lease; a running run has started and holds
       a lease; a finished run has finished and holds no lease.';
    comment on constraint ck_test_runs_results_only_when_finished on test_runs is
      'results (the tester''s answer, an error) only on a succeeded or failed
       run: a queued or running one has none, so a member''s insert carries
       none.';

    drop table validation_rules;
    drop function refuse_validation_rule_identity_change();
    drop table validation_pipelines;
  `);
};
