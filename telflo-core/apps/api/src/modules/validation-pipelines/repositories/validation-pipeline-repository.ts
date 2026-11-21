import { sql, type Selectable, type Transaction } from "kysely";
import type { Database, TestRunSignal, ValidationPipelinesTable } from "@telflo/db";
import type { AuthContext } from "../../../database/context.js";
import { createOrganizationScope } from "../../../tenancy/organization-scope.js";
import { visibleTo } from "../../configurations/repositories/configuration-repository.js";

/*
 * A configuration version's validation pipelines, through the organization
 * scope, as the context's user sees them: a pipeline is visible exactly when
 * its configuration is (their own draft, or a published one), by the
 * configurations' own rule (`visibleTo`), which is migration 030's select
 * policy (021's childVisible). A deleted configuration's are hidden, as its
 * suites are. Row-level security stands behind it, so the transaction must
 * carry a database context naming the same organization and user.
 *
 * A pipeline is created and deleted, never changed. Every write here is made
 * under the configuration's lock (the service's lockAsMember, then
 * lockedConfiguration), so a read made under it holds until the transaction
 * ends.
 */

/** Whom the repository reads for: the organization, and the viewer whose drafts' pipelines it shows. An `AuthContext` is one. */
export type ValidationPipelineViewerContext = Pick<AuthContext, "organizationId" | "userId">;

/** A validation pipeline. Its pipeline name is configuration text. */
export interface ValidationPipeline {
  id: string;
  configurationId: string;
  versionId: string;
  /** The YAML pipeline it validates (`logs/default`). */
  pipeline: string;
  /** The name's first part. */
  signal: TestRunSignal;
  /** Null once the creator's account is hard-deleted. */
  createdByUserId: string | null;
  createdAt: Date;
}

export interface CreateValidationPipelineInput {
  configurationId: string;
  versionId: string;
  /** 1 to 200 characters, its first part a signal: the contract checks it, and the table refuses anything else. */
  pipeline: string;
  /** The name's first part (signalOfPipeline). */
  signal: TestRunSignal;
  /** The context's user: the insert policy admits no one else. */
  createdByUserId: string;
  /** From the API's clock. */
  at: Date;
}

/** What a version copy wrote: counts only. */
export interface CopiedValidationPipelines {
  pipelines: number;
  rules: number;
}

export interface IValidationPipelineRepository {
  /** The version's pipelines the viewer can see, oldest first (created_at, then id). No cap. */
  listForVersion(configurationId: string, versionId: string): Promise<ValidationPipeline[]>;
  /** A pipeline the viewer can see, by id alone; undefined otherwise. */
  find(id: string): Promise<ValidationPipeline | undefined>;
  /** A pipeline the viewer can see on that configuration's version; undefined otherwise (another version's included). */
  findInVersion(configurationId: string, versionId: string, id: string): Promise<ValidationPipeline | undefined>;
  /** The version's pipeline for that YAML pipeline, if any: read under the configuration's lock, before a create. */
  findByName(configurationId: string, versionId: string, pipeline: string): Promise<ValidationPipeline | undefined>;
  /**
   * A new pipeline on the version. Undefined when the version already has
   * one for that YAML pipeline (uq_validation_pipelines_version_pipeline_name,
   * 23505): a backstop behind findByName under the lock. The statement
   * failed, so the transaction is aborted: the caller lets it roll back.
   */
  create(input: CreateValidationPipelineInput): Promise<ValidationPipeline | undefined>;
  /** Deletes a visible pipeline (its rules go with it, fk_validation_rules_validation_pipeline). False when there is none. */
  remove(id: string): Promise<boolean>;
  /**
   * A new version's copy of its source's validation pipelines and rules, in
   * one statement, as the context's user under row-level security: every
   * pipeline of `fromVersionId` the viewer can see, in its (created_at, id)
   * order, each under a new uuidv7(), whether or not its name is still in the
   * text; then their rules in (the pipeline's place, position) order, each
   * keeping its position and its owner (`is_api_owned`: the public API's next
   * PUT on the new version replaces the copies of its rules). The copies'
   * creator is the context's user and their times `at`, the version's; both
   * versions are the configuration's. Run it under the configuration's lock
   * (createVersion's). Counts only.
   */
  copyToVersion(
    configurationId: string,
    fromVersionId: string,
    toVersionId: string,
    at: Date,
  ): Promise<CopiedValidationPipelines>;
}

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505";

/** One validation pipeline per version and YAML pipeline (migration 030). */
const PIPELINE_NAME_UNIQUE_CONSTRAINT = "uq_validation_pipelines_version_pipeline_name";

/** True only for that constraint's violation: any other is a bug, and surfaces as one. */
function isPipelineNameViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION &&
    "constraint" in error &&
    error.constraint === PIPELINE_NAME_UNIQUE_CONSTRAINT
  );
}

function toValidationPipeline(row: Selectable<ValidationPipelinesTable>): ValidationPipeline {
  return {
    id: row.id,
    configurationId: row.configuration_id,
    versionId: row.configuration_version_id,
    pipeline: row.pipeline_name,
    signal: row.signal,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

/** Bound to a transaction carrying the same database context as `context`. */
export function createValidationPipelineRepository(
  transaction: Transaction<Database>,
  context: ValidationPipelineViewerContext,
): IValidationPipelineRepository {
  const scope = createOrganizationScope(transaction, context);
  const viewer = context.userId;

  /** The pipelines the viewer can see: joined to their live configuration, which they created or which is published. */
  const visible = () =>
    scope
      .selectFrom("validation_pipelines")
      .innerJoin("configurations", (join) =>
        join
          .onRef("configurations.id", "=", "validation_pipelines.configuration_id")
          .onRef("configurations.organization_id", "=", "validation_pipelines.organization_id"),
      )
      .where("configurations.deleted_at", "is", null)
      .where(visibleTo(viewer));

  /** The same rule for a delete's `where`: the pipeline's configuration, live and visible. */
  const isVisible = sql<boolean>`exists (
    select 1 from configurations
     where configurations.id = validation_pipelines.configuration_id
       and configurations.organization_id = validation_pipelines.organization_id
       and configurations.deleted_at is null
       and ${visibleTo(viewer)})`;

  return {
    async listForVersion(configurationId, versionId) {
      const rows = await visible()
        .selectAll("validation_pipelines")
        .where("validation_pipelines.configuration_id", "=", configurationId)
        .where("validation_pipelines.configuration_version_id", "=", versionId)
        .orderBy("validation_pipelines.created_at", "asc")
        .orderBy("validation_pipelines.id", "asc")
        .execute();
      return rows.map(toValidationPipeline);
    },

    async find(id) {
      const row = await visible()
        .selectAll("validation_pipelines")
        .where("validation_pipelines.id", "=", id)
        .executeTakeFirst();
      return row ? toValidationPipeline(row) : undefined;
    },

    async findInVersion(configurationId, versionId, id) {
      const row = await visible()
        .selectAll("validation_pipelines")
        .where("validation_pipelines.id", "=", id)
        .where("validation_pipelines.configuration_id", "=", configurationId)
        .where("validation_pipelines.configuration_version_id", "=", versionId)
        .executeTakeFirst();
      return row ? toValidationPipeline(row) : undefined;
    },

    async findByName(configurationId, versionId, pipeline) {
      const row = await visible()
        .selectAll("validation_pipelines")
        .where("validation_pipelines.configuration_id", "=", configurationId)
        .where("validation_pipelines.configuration_version_id", "=", versionId)
        .where("validation_pipelines.pipeline_name", "=", pipeline)
        .executeTakeFirst();
      return row ? toValidationPipeline(row) : undefined;
    },

    async create(input) {
      try {
        const row = await scope
          .insertInto("validation_pipelines", {
            configuration_id: input.configurationId,
            configuration_version_id: input.versionId,
            pipeline_name: input.pipeline,
            signal: input.signal,
            created_by_user_id: input.createdByUserId,
            created_at: input.at,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toValidationPipeline(row);
      } catch (error) {
        if (isPipelineNameViolation(error)) return undefined;
        throw error;
      }
    },

    async remove(id) {
      const result = await scope
        .deleteFrom("validation_pipelines")
        .where("validation_pipelines.id", "=", id)
        .where(isVisible)
        .executeTakeFirst();
      return result.numDeletedRows === 1n;
    },

    async copyToVersion(configurationId, fromVersionId, toVersionId, at) {
      // As the suites' copy (test-suite-repository.ts): the map is
      // materialized in the source's (created_at, id) order, so each new id
      // is taken in that order (Postgres 18's uuidv7() rises within a
      // backend), and the copies keep the source's order with every copy at
      // one created_at. The rules are inserted in (the pipeline's place,
      // position) order with their positions kept, so their default
      // uuidv7() ids rise the same way. The select policies show the viewer
      // only what they may see, and the insert policies admit the viewer
      // alone as the creator. The identity trigger guards updates only.
      const organizationId = context.organizationId;
      const { rows } = await sql<{ pipelines: number; rules: number }>`
        with map as materialized (
          select ordered.id as old_id, uuidv7() as new_id, ordered.place
            from (select p.id, row_number() over (order by p.created_at, p.id) as place
                    from validation_pipelines p
                   where p.organization_id = ${organizationId}
                     and p.configuration_id = ${configurationId}
                     and p.configuration_version_id = ${fromVersionId}
                   order by p.created_at, p.id) ordered
           order by ordered.place
        ), pipelines as (
          insert into validation_pipelines
            (id, organization_id, configuration_id, configuration_version_id,
             pipeline_name, signal, created_by_user_id, created_at)
          select m.new_id, p.organization_id, p.configuration_id, ${toVersionId},
                 p.pipeline_name, p.signal, ${viewer}, ${at}
            from map m join validation_pipelines p on p.id = m.old_id
           order by m.place
          returning id
        ), rules as (
          insert into validation_rules
            (organization_id, configuration_id, configuration_version_id, validation_pipeline_id, position,
             kind, target, pattern, ottl_context, ottl_condition, ottl_quantifier, ottl_count_operator,
             ottl_count_value, ottl_count_value2, ottl_expression, name, description, is_api_owned,
             created_by_user_id, created_at, updated_at)
          select r.organization_id, r.configuration_id, ${toVersionId}, m.new_id, r.position,
                 r.kind, r.target, r.pattern, r.ottl_context, r.ottl_condition, r.ottl_quantifier, r.ottl_count_operator,
                 r.ottl_count_value, r.ottl_count_value2, r.ottl_expression, r.name, r.description, r.is_api_owned,
                 ${viewer}, ${at}, ${at}
            from map m join validation_rules r on r.validation_pipeline_id = m.old_id
           order by m.place, r.position
          returning id
        )
        select (select count(*) from pipelines)::integer as pipelines,
               (select count(*) from rules)::integer as rules
      `.execute(transaction);
      const copied = rows[0];
      if (copied === undefined) throw new Error("the validation pipelines' version copy returned no row");
      return { pipelines: copied.pipelines, rules: copied.rules };
    },
  };
}
