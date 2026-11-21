import { sql, type Selectable, type Transaction } from "kysely";
import type { ValidationRuleSnapshot } from "@telflo/contracts";
import type { Database, TestRunSignal, TestRunStatus, TestRunsTable } from "@telflo/db";
import type { AuthContext } from "../../../database/context.js";
import { createOrganizationScope } from "../../../tenancy/organization-scope.js";
import { visibleTo } from "../../configurations/repositories/configuration-repository.js";

/*
 * The test runs of the context's organization, through the organization scope,
 * as the context's user sees them: a run is visible exactly when its
 * configuration is (their own draft, or a published one), by the
 * configurations' own rule (`visibleTo`), which is the select policy's
 * (migration 028's childVisible). Row-level security stands behind it, so the
 * transaction must carry a database context naming the same organization and
 * user.
 *
 * A deleted configuration's runs are hidden: the policies don't hide them,
 * so the repository does. Their rows and files are kept.
 *
 * The API's role adds a queued run and changes none: a run's status and
 * results change only through the dispatcher's functions, so there is no
 * update or delete here.
 *
 * A queued run snapshots its pipeline's validation rules in its own insert:
 * the validation pipeline of the run's version named by its pipeline, of its
 * signal, and its rules in position order, read through row-level security as
 * the context's user, so a re-run takes the rules as they are now. Never from
 * the request, with one narrow, named exception: the public API's run with
 * inline rules passes them, checked and given fresh ids, as `inlineRules`, and
 * its insert writes them instead. Only the public route passes it.
 *
 * A YAML run (migration 1700000000040) has no configuration: `visible()`
 * joins every run to its configuration, so `find` and the version's list
 * never answer one; `findYamlRun` reads one, its creator's own, in the
 * context's organization (the select policy's own rule, which row-level
 * security applies too).
 */

/** Whom the repository reads for: the organization, and the viewer whose drafts' runs it shows. An `AuthContext` is one. */
export type TestRunViewerContext = Pick<AuthContext, "organizationId" | "userId">;

/** A run as a version's list shows it: no text, logs or results. */
export interface TestRunSummary {
  id: string;
  configurationId: string;
  versionId: string;
  status: TestRunStatus;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  pipeline: string;
  signal: TestRunSignal;
  durationSeconds: number;
  collectorDistribution: string;
  collectorVersion: string;
  queuedByUserId: string | null;
  /** Private text. */
  inputName: string;
  inputSizeBytes: number;
  sourceRunId: string | null;
  errorCode: string | null;
  /** Null when the run stored no output; the output read answers 404 then. */
  outputSizeBytes: number | null;
  /** Null when the run stored no decoded input. */
  decodedInputSizeBytes: number | null;
  /**
   * The breadcrumb: the suite and the definition a run from a definition
   * was queued from, or a re-run of one, as they were then; all four null
   * for every other run. The names are private text.
   */
  suiteId: string | null;
  suiteName: string | null;
  definitionId: string | null;
  definitionName: string | null;
}

/** A run's breadcrumb, all four set (migration 029's ck_test_runs_breadcrumb). */
export interface TestRunBreadcrumb {
  suiteId: string;
  suiteName: string;
  definitionId: string;
  definitionName: string;
}

/** A run in full: its snapshot and its results (null until it has ended). */
export interface TestRun extends TestRunSummary {
  /** The text run, organization variables substituted. Private. */
  yaml: string;
  strategy: string | null;
  kwokEnabled: boolean | null;
  /** Private. */
  mutatedYaml: string | null;
  mutations: unknown[] | null;
  compatibility: unknown[] | null;
  /** Private. */
  logs: string | null;
  timings: Record<string, unknown> | null;
  outputTruncated: boolean | null;
  decodedInputTruncated: boolean | null;
  errorMessage: string | null;
  /** The validation pipeline whose rules the run copied when it was queued; null when there was none. */
  validationPipelineId: string | null;
  /**
   * The rules' snapshot: the contracts' ValidationRuleSnapshotSchema's
   * shape, in position order; [] for none. Configuration text.
   */
  validationRules: unknown[];
  /** The rules' results, one per rule in its order; null until checked. Configuration text. */
  validationResults: unknown[] | null;
}

/**
 * A YAML run: a run with no configuration and no version, otherwise a run in
 * full. Its creator's alone.
 */
export interface YamlTestRun extends Omit<TestRun, "configurationId" | "versionId"> {
  configurationId: null;
  versionId: null;
}

/** A run of either kind: a configuration version's, or a YAML run. */
export type AnyTestRun = TestRun | YamlTestRun;

/** A queued run's snapshot, as the queue's service builds it. */
export interface CreateTestRunInput {
  /** Chosen before the insert (nextId): the input was copied under it first. */
  id: string;
  /** Both null for a YAML run, both set otherwise. */
  configurationId: string | null;
  versionId: string | null;
  sourceRunId: string | null;
  yaml: string;
  pipeline: string;
  signal: TestRunSignal;
  durationSeconds: number;
  collectorDistribution: string;
  collectorVersion: string;
  inputName: string;
  inputSizeBytes: number;
  /** A definition's run's (or a re-run of one's) suite and definition; null for every other run. */
  breadcrumb: TestRunBreadcrumb | null;
  /**
   * The rules' snapshot the public API's run takes from its request: checked,
   * with fresh ids, in their order (`[]` for none). Given, it is written as it
   * is, with no validation pipeline; left out (every other run), the insert
   * takes the snapshot from the database.
   */
  inlineRules?: readonly ValidationRuleSnapshot[];
}

export interface ITestRunRepository {
  /** A new id, uuidv7 by the database's clock, for a run whose input is copied before its row. */
  nextId(): Promise<string>;
  /** A run the viewer can see in the organization, its configuration live; undefined otherwise. */
  find(id: string): Promise<TestRun | undefined>;
  /**
   * A YAML run of the viewer in the organization; undefined for any other
   * run, another person's YAML run included.
   */
  findYamlRun(id: string): Promise<YamlTestRun | undefined>;
  /** As `find`, and only when the run is of that configuration's version. */
  findInVersion(configurationId: string, versionId: string, id: string): Promise<TestRun | undefined>;
  /** The version's runs the viewer can see, newest first, at most `limit`; none when its configuration is deleted. */
  listForVersion(configurationId: string, versionId: string, limit: number): Promise<TestRunSummary[]>;
  /**
   * How many waiting runs, in every organization, start before each of `ids`
   * that is waiting and that the viewer can see (test_runs_ahead): a count
   * only. Ids it doesn't answer for are absent.
   */
  aheadOf(ids: readonly string[]): Promise<Map<string, number>>;
  /**
   * Whether the version's validation pipeline named `pipeline`, of `signal`,
   * has a rule the viewer can see: a run of it would carry rules.
   */
  hasValidationRules(versionId: string, pipeline: string, signal: TestRunSignal): Promise<boolean>;
  /**
   * Inserts a queued run as the context's user, queued now by the
   * database's clock (the insert policy admits nothing else), and returns
   * it. The configuration must be one the viewer can see (42501 otherwise).
   * The insert itself takes the rules' snapshot: the version's validation
   * pipeline named by the run's pipeline, of its signal, and its rules in
   * position order, as the viewer sees them (none: no pipeline, `[]`); or,
   * given `inlineRules`, those and no pipeline. A YAML run (no
   * configuration) is the viewer's own in the organization.
   */
  create(input: CreateTestRunInput): Promise<AnyTestRun>;
  /**
   * The context's user's waiting runs in the context's organization
   * (test_runs_waiting_for_context_user: the cap is per person, per
   * organization).
   */
  waitingForCurrentUser(): Promise<number>;
  /**
   * Holds, until the transaction ends, a lock that every queuing of the
   * context's user in the context's organization takes before counting
   * their waiting runs there, in every API process: two of their runs
   * queued at once can't both pass the cap. Keyed by the person and the
   * organization, as the cap counts.
   */
  lockQueueForCurrentUser(): Promise<void>;
}

const summaryColumns = [
  "test_runs.id",
  "test_runs.configuration_id",
  "test_runs.configuration_version_id",
  "test_runs.status",
  "test_runs.queued_at",
  "test_runs.started_at",
  "test_runs.finished_at",
  "test_runs.target_pipeline",
  "test_runs.signal",
  "test_runs.duration_seconds",
  "test_runs.collector_distribution",
  "test_runs.collector_version",
  "test_runs.queued_by_user_id",
  "test_runs.input_name",
  "test_runs.input_size_bytes",
  "test_runs.source_run_id",
  "test_runs.error_code",
  "test_runs.output_size_bytes",
  "test_runs.decoded_input_size_bytes",
  "test_runs.test_suite_id",
  "test_runs.test_suite_name",
  "test_runs.test_definition_id",
  "test_runs.test_definition_name",
] as const;

type SummaryRow = Pick<
  Selectable<TestRunsTable>,
  | "id"
  | "configuration_id"
  | "configuration_version_id"
  | "status"
  | "queued_at"
  | "started_at"
  | "finished_at"
  | "target_pipeline"
  | "signal"
  | "duration_seconds"
  | "collector_distribution"
  | "collector_version"
  | "queued_by_user_id"
  | "input_name"
  | "input_size_bytes"
  | "source_run_id"
  | "error_code"
  | "output_size_bytes"
  | "decoded_input_size_bytes"
  | "test_suite_id"
  | "test_suite_name"
  | "test_definition_id"
  | "test_definition_name"
>;

/**
 * A run's configuration and version, as `visible()` reads them: joined to
 * its configuration, so always set. A YAML run (both null) is never one of
 * its rows; one reaching here is a bug.
 */
function versionIdsOf(row: Pick<SummaryRow, "configuration_id" | "configuration_version_id">): {
  configurationId: string;
  versionId: string;
} {
  if (row.configuration_id === null || row.configuration_version_id === null) {
    throw new Error("a configuration's run was read without its configuration");
  }
  return { configurationId: row.configuration_id, versionId: row.configuration_version_id };
}

/** A run's list fields but its configuration and version. */
function summaryFieldsOf(row: SummaryRow): Omit<TestRunSummary, "configurationId" | "versionId"> {
  return {
    id: row.id,
    status: row.status,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    pipeline: row.target_pipeline,
    signal: row.signal,
    durationSeconds: row.duration_seconds,
    collectorDistribution: row.collector_distribution,
    collectorVersion: row.collector_version,
    queuedByUserId: row.queued_by_user_id,
    inputName: row.input_name,
    inputSizeBytes: row.input_size_bytes,
    sourceRunId: row.source_run_id,
    errorCode: row.error_code,
    outputSizeBytes: row.output_size_bytes,
    decodedInputSizeBytes: row.decoded_input_size_bytes,
    suiteId: row.test_suite_id,
    suiteName: row.test_suite_name,
    definitionId: row.test_definition_id,
    definitionName: row.test_definition_name,
  };
}

function toSummary(row: SummaryRow): TestRunSummary {
  return { ...summaryFieldsOf(row), ...versionIdsOf(row) };
}

/** A run's fields in full but its configuration and version. */
function runFieldsOf(row: Selectable<TestRunsTable>): Omit<TestRun, "configurationId" | "versionId"> {
  return {
    ...summaryFieldsOf(row),
    yaml: row.yaml,
    strategy: row.strategy,
    kwokEnabled: row.kwok_enabled,
    mutatedYaml: row.mutated_yaml,
    mutations: row.mutations,
    compatibility: row.compatibility,
    logs: row.logs,
    timings: row.timings,
    outputTruncated: row.output_truncated,
    decodedInputTruncated: row.decoded_input_truncated,
    errorMessage: row.error_message,
    validationPipelineId: row.validation_pipeline_id,
    validationRules: row.validation_rules,
    validationResults: row.validation_results,
  };
}

function toTestRun(row: Selectable<TestRunsTable>): TestRun {
  return { ...runFieldsOf(row), ...versionIdsOf(row) };
}

/** A run of either kind, as its row is: a YAML run's ids are both null. */
function toAnyTestRun(row: Selectable<TestRunsTable>): AnyTestRun {
  if (row.configuration_id === null && row.configuration_version_id === null) {
    return { ...runFieldsOf(row), configurationId: null, versionId: null };
  }
  return toTestRun(row);
}

/**
 * One rule as a run's snapshot holds it, from a row of validation_rules
 * aliased `r`: the contracts' ValidationRuleSnapshotSchema (id, position,
 * kind, target, pattern or null, OTTL or null, name, description). The OTTL
 * object leaves out a field whose column is null, as the contract has it
 * (and as the rules' repository answers it): jsonb_strip_nulls inside it,
 * its count's value2 included.
 */
const snapshotRule = sql`jsonb_build_object(
    'id', r.id,
    'position', r.position,
    'kind', r.kind,
    'target', r.target,
    'pattern', case when r.kind = 'ottl' then null else r.pattern end,
    'ottl', case when r.kind = 'ottl' then jsonb_strip_nulls(jsonb_build_object(
        'context', r.ottl_context,
        'quantifier', r.ottl_quantifier,
        'condition', r.ottl_condition,
        'expression', r.ottl_expression,
        'count', case when r.ottl_count_operator is null then null else jsonb_build_object(
            'operator', r.ottl_count_operator,
            'value', r.ottl_count_value,
            'value2', r.ottl_count_value2) end)) else null end,
    'name', r.name,
    'description', r.description)`;

/** Bound to a transaction carrying the same database context as `context`. */
export function createTestRunRepository(
  transaction: Transaction<Database>,
  context: TestRunViewerContext,
): ITestRunRepository {
  const scope = createOrganizationScope(transaction, context);
  const viewer = context.userId;

  /**
   * The runs the viewer can see: joined to their live configuration in the
   * same organization, which they created or which is published.
   */
  const visible = () =>
    scope
      .selectFrom("test_runs")
      .innerJoin("configurations", (join) =>
        join
          .onRef("configurations.id", "=", "test_runs.configuration_id")
          .onRef("configurations.organization_id", "=", "test_runs.organization_id"),
      )
      .where("configurations.deleted_at", "is", null)
      .where(visibleTo(viewer));

  return {
    async nextId() {
      const { rows } = await sql<{ id: string }>`select uuidv7()::text as id`.execute(transaction);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error("uuidv7() returned no row");
      return id;
    },

    async find(id) {
      const row = await visible().selectAll("test_runs").where("test_runs.id", "=", id).executeTakeFirst();
      return row ? toTestRun(row) : undefined;
    },

    async findYamlRun(id) {
      // The select policy's own rule for a YAML run (migration 1700000000040),
      // stated here too, as `visible()` states the configurations': no
      // configuration, the viewer's, in the scope's organization.
      const row = await scope
        .selectFrom("test_runs")
        .selectAll("test_runs")
        .where("test_runs.id", "=", id)
        .where("test_runs.configuration_id", "is", null)
        .where("test_runs.queued_by_user_id", "=", viewer)
        .executeTakeFirst();
      if (!row) return undefined;
      const run = toAnyTestRun(row);
      return run.configurationId === null ? run : undefined;
    },

    async findInVersion(configurationId, versionId, id) {
      const row = await visible()
        .selectAll("test_runs")
        .where("test_runs.id", "=", id)
        .where("test_runs.configuration_id", "=", configurationId)
        .where("test_runs.configuration_version_id", "=", versionId)
        .executeTakeFirst();
      return row ? toTestRun(row) : undefined;
    },

    async listForVersion(configurationId, versionId, limit) {
      const rows = await visible()
        .select(summaryColumns)
        .where("test_runs.configuration_id", "=", configurationId)
        .where("test_runs.configuration_version_id", "=", versionId)
        .orderBy("test_runs.queued_at", "desc")
        .orderBy("test_runs.id", "desc")
        .limit(limit)
        .execute();
      return rows.map(toSummary);
    },

    async aheadOf(ids) {
      if (ids.length === 0) return new Map();
      const { rows } = await sql<{ run_id: string; ahead: number }>`
        select run_id, ahead from test_runs_ahead(${sql.val([...ids])}::uuid[])
      `.execute(transaction);
      return new Map(rows.map((row) => [row.run_id, row.ahead]));
    },

    async hasValidationRules(versionId, pipeline, signal) {
      // Row-level security decides what the viewer sees, as the snapshot's
      // insert reads it; the organization is named too, as the scope would.
      const { rows } = await sql<{ has_rules: boolean }>`
        select exists (
          select 1
            from validation_pipelines vp
            join validation_rules r
              on r.validation_pipeline_id = vp.id
             and r.configuration_version_id = vp.configuration_version_id
             and r.organization_id = vp.organization_id
           where vp.organization_id = ${context.organizationId}
             and vp.configuration_version_id = ${versionId}
             and vp.pipeline_name = ${pipeline}
             and vp.signal = ${signal}
        ) as has_rules
      `.execute(transaction);
      return rows[0]?.has_rules === true;
    },

    async create(input) {
      if (input.inlineRules !== undefined) {
        // The public API's run: the request's checked rules, with fresh ids,
        // as they are; no validation pipeline. The insert policy checks the
        // organization, the configuration (or a YAML run's creator) and the
        // user.
        const { rows } = await sql<Selectable<TestRunsTable>>`
          insert into test_runs
            (id, organization_id, configuration_id, configuration_version_id, queued_by_user_id, source_run_id,
             yaml, target_pipeline, signal, duration_seconds, collector_distribution, collector_version,
             input_name, input_size_bytes, test_suite_id, test_suite_name, test_definition_id, test_definition_name,
             validation_pipeline_id, validation_rules)
          values (${input.id}::uuid, ${context.organizationId}::uuid, ${input.configurationId}::uuid,
                  ${input.versionId}::uuid, ${viewer}::uuid, ${input.sourceRunId}::uuid,
                  ${input.yaml}::text, ${input.pipeline}::text, ${input.signal}::text, ${input.durationSeconds}::integer,
                  ${input.collectorDistribution}::text, ${input.collectorVersion}::text,
                  ${input.inputName}::text, ${input.inputSizeBytes}::integer,
                  ${input.breadcrumb?.suiteId ?? null}::uuid, ${input.breadcrumb?.suiteName ?? null}::text,
                  ${input.breadcrumb?.definitionId ?? null}::uuid, ${input.breadcrumb?.definitionName ?? null}::text,
                  null, ${JSON.stringify(input.inlineRules)}::jsonb)
          returning *
        `.execute(transaction);
        const row = rows[0];
        if (row === undefined) throw new Error("the run's insert returned no row");
        return toAnyTestRun(row);
      }
      // One INSERT … SELECT: the run's row, and its rules' snapshot from the
      // version's validation pipeline for its pipeline and signal (a left
      // join: none gives no pipeline and []), its rules aggregated in
      // position order, both read through row-level security as the viewer,
      // in this one statement. The organization is the context's, as the
      // scope would set it, and the insert policy checks it.
      const { rows } = await sql<Selectable<TestRunsTable>>`
        insert into test_runs
          (id, organization_id, configuration_id, configuration_version_id, queued_by_user_id, source_run_id,
           yaml, target_pipeline, signal, duration_seconds, collector_distribution, collector_version,
           input_name, input_size_bytes, test_suite_id, test_suite_name, test_definition_id, test_definition_name,
           validation_pipeline_id, validation_rules)
        select ${input.id}::uuid, ${context.organizationId}::uuid, ${input.configurationId}::uuid,
               ${input.versionId}::uuid, ${viewer}::uuid, ${input.sourceRunId}::uuid,
               ${input.yaml}::text, ${input.pipeline}::text, ${input.signal}::text, ${input.durationSeconds}::integer,
               ${input.collectorDistribution}::text, ${input.collectorVersion}::text,
               ${input.inputName}::text, ${input.inputSizeBytes}::integer,
               ${input.breadcrumb?.suiteId ?? null}::uuid, ${input.breadcrumb?.suiteName ?? null}::text,
               ${input.breadcrumb?.definitionId ?? null}::uuid, ${input.breadcrumb?.definitionName ?? null}::text,
               vp.id, coalesce(snapshot.rules, '[]'::jsonb)
          from (select 1) as run
          left join validation_pipelines vp
            on vp.organization_id = ${context.organizationId}::uuid
           and vp.configuration_id = ${input.configurationId}::uuid
           and vp.configuration_version_id = ${input.versionId}::uuid
           and vp.pipeline_name = ${input.pipeline}::text
           and vp.signal = ${input.signal}::text
          left join lateral (
            select jsonb_agg(${snapshotRule} order by r.position) as rules
              from validation_rules r
             where r.validation_pipeline_id = vp.id
               and r.configuration_version_id = vp.configuration_version_id
               and r.organization_id = vp.organization_id
          ) snapshot on true
        returning *
      `.execute(transaction);
      const row = rows[0];
      if (row === undefined) throw new Error("the run's insert returned no row");
      return toAnyTestRun(row);
    },

    async waitingForCurrentUser() {
      const { rows } = await sql<{ waiting: number }>`
        select test_runs_waiting_for_context_user() as waiting
      `.execute(transaction);
      return rows[0]?.waiting ?? 0;
    },

    async lockQueueForCurrentUser() {
      const key = `telflo.test_runs_queue:${context.organizationId}:${viewer}`;
      await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(transaction);
    },
  };
}
