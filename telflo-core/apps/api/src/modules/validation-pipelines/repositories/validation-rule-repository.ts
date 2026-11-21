import { sql, type Selectable, type Transaction } from "kysely";
import type { ValidationRuleOttl } from "@telflo/contracts";
import type { Database, ValidationRuleKind, ValidationRulesTable, ValidationRuleTarget } from "@telflo/db";
import type { AuthContext } from "../../../database/context.js";
import { createOrganizationScope } from "../../../tenancy/organization-scope.js";
import { visibleTo } from "../../configurations/repositories/configuration-repository.js";

/*
 * A validation pipeline's rules, through the organization scope, as the
 * context's user sees them: a rule is visible exactly when its configuration
 * is, by the configurations' own rule (`visibleTo`), migration 030's select
 * policy. Row-level security stands behind it.
 *
 * A rule's OTTL is stored as columns and answered as the contract's object.
 * Every write here is made under the configuration's lock (the service's
 * lockAsMember, then lockedConfiguration), so the count and the next
 * position read under it hold until the transaction ends; the unique
 * (pipeline, position) key is the backstop. What is written is what the
 * contracts' schemas parsed (CreateValidationRuleRequestSchema,
 * UpdateValidationRuleRequestSchema): the table's blank check is ASCII
 * only, so the schemas' (Unicode's whitespace) are the gate.
 */

/** Whom the repository reads for. An `AuthContext` is one. */
export type ValidationRuleViewerContext = Pick<AuthContext, "organizationId" | "userId">;

/** What a rule checks: its kind, target, and its pattern (text and regex kinds) or OTTL (the OTTL kind). */
export interface ValidationRuleContent {
  kind: ValidationRuleKind;
  target: ValidationRuleTarget;
  /** A text or regex rule's; null for an OTTL rule. Configuration text. */
  pattern: string | null;
  /** An OTTL rule's; null for the others. Configuration text. */
  ottl: ValidationRuleOttl | null;
}

/** A rule. Its name, description, pattern and OTTL are configuration text. */
export interface ValidationRule extends ValidationRuleContent {
  id: string;
  validationPipelineId: string;
  /** From 1, unique in its pipeline; gaps after deletes. Never changed. */
  position: number;
  name: string;
  description: string;
  /** Written by the public API's PUT, which the next PUT replaces; false for a person's. */
  isApiOwned: boolean;
  /** Null once the creator's account is hard-deleted. */
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateValidationRuleInput {
  configurationId: string;
  versionId: string;
  validationPipelineId: string;
  content: ValidationRuleContent;
  /** Trimmed, at most 200 characters; `''` for none. */
  name: string;
  /** At most 2,000 characters; `''` for none. */
  description: string;
  /** The context's user: the insert policy admits no one else. */
  createdByUserId: string;
  /** Created and updated at this time, from the API's clock. */
  at: Date;
  /** The public API's PUT writes its rules as its own; every other create, false. */
  isApiOwned?: boolean;
}

/** A rule's changes: what it checks (whole), its name, its description; a field left out stays as it is. */
export interface ValidationRuleChanges {
  content?: ValidationRuleContent;
  name?: string;
  description?: string;
}

export interface IValidationRuleRepository {
  /** The pipeline's rules the viewer can see, in position order, at most `limit`. */
  listForPipeline(validationPipelineId: string, limit: number): Promise<ValidationRule[]>;
  /**
   * Every rule the viewer can see of the version's pipelines, by pipeline
   * then position: the public list's one read. At most
   * VALIDATION_RULES_PER_PIPELINE_MAXIMUM per pipeline, which the API keeps.
   */
  listForVersion(configurationId: string, versionId: string): Promise<ValidationRule[]>;
  /** A rule the viewer can see, by id alone; undefined otherwise. */
  find(id: string): Promise<ValidationRule | undefined>;
  /** A rule the viewer can see in that pipeline; undefined otherwise (another pipeline's included). */
  findInPipeline(validationPipelineId: string, id: string): Promise<ValidationRule | undefined>;
  /**
   * How many rules the pipeline has: the cap's count, read under the
   * configuration's lock. With `isApiOwned`, only the public API's (true) or
   * only the others (false).
   */
  countInPipeline(validationPipelineId: string, isApiOwned?: boolean): Promise<number>;
  /** A new rule at the pipeline's largest position plus one (1 for its first), in one statement. */
  create(input: CreateValidationRuleInput): Promise<ValidationRule>;
  /** Sets the fields given and `updated_at` to `at` on a visible rule; undefined when there is none. */
  update(id: string, changes: ValidationRuleChanges, at: Date): Promise<ValidationRule | undefined>;
  /** Deletes a visible rule. False when there is none. */
  remove(id: string): Promise<boolean>;
  /**
   * Deletes the pipeline's visible rules the public API wrote
   * (`is_api_owned`), a person's left alone; the deleted rules' ids, in
   * position order. Run under the configuration's lock.
   */
  removeApiOwned(validationPipelineId: string): Promise<string[]>;
}

/** The OTTL object of a rule's columns, a field left out when its column is null (as the contract has it). */
function ottlOf(row: Selectable<ValidationRulesTable>): ValidationRuleOttl | null {
  if (row.kind !== "ottl" || row.ottl_context === null || row.ottl_quantifier === null) return null;
  return {
    context: row.ottl_context,
    quantifier: row.ottl_quantifier,
    ...(row.ottl_condition === null ? {} : { condition: row.ottl_condition }),
    ...(row.ottl_expression === null ? {} : { expression: row.ottl_expression }),
    ...(row.ottl_count_operator === null || row.ottl_count_value === null
      ? {}
      : {
          count: {
            operator: row.ottl_count_operator,
            value: row.ottl_count_value,
            ...(row.ottl_count_value2 === null ? {} : { value2: row.ottl_count_value2 }),
          },
        }),
  };
}

function toValidationRule(row: Selectable<ValidationRulesTable>): ValidationRule {
  return {
    id: row.id,
    validationPipelineId: row.validation_pipeline_id,
    position: row.position,
    kind: row.kind,
    target: row.target,
    pattern: row.kind === "ottl" ? null : row.pattern,
    ottl: ottlOf(row),
    name: row.name,
    description: row.description,
    isApiOwned: row.is_api_owned,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The content's columns: an OTTL rule's OTTL and no pattern, or a pattern and no OTTL (migration 030's checks). */
function contentColumns(content: ValidationRuleContent) {
  const ottl = content.kind === "ottl" ? content.ottl : null;
  return {
    kind: content.kind,
    target: content.target,
    pattern: content.kind === "ottl" ? null : content.pattern,
    ottl_context: ottl?.context ?? null,
    ottl_condition: ottl?.condition ?? null,
    ottl_quantifier: ottl?.quantifier ?? null,
    ottl_count_operator: ottl?.count?.operator ?? null,
    ottl_count_value: ottl?.count?.value ?? null,
    ottl_count_value2: ottl?.count?.value2 ?? null,
    ottl_expression: ottl?.expression ?? null,
  };
}

/** Bound to a transaction carrying the same database context as `context`. */
export function createValidationRuleRepository(
  transaction: Transaction<Database>,
  context: ValidationRuleViewerContext,
): IValidationRuleRepository {
  const scope = createOrganizationScope(transaction, context);
  const viewer = context.userId;

  /** The rules the viewer can see: joined to their live configuration, which they created or which is published. */
  const visible = () =>
    scope
      .selectFrom("validation_rules")
      .innerJoin("configurations", (join) =>
        join
          .onRef("configurations.id", "=", "validation_rules.configuration_id")
          .onRef("configurations.organization_id", "=", "validation_rules.organization_id"),
      )
      .where("configurations.deleted_at", "is", null)
      .where(visibleTo(viewer));

  /** The same rule for a write's `where`: the rule's configuration, live and visible. */
  const isVisible = sql<boolean>`exists (
    select 1 from configurations
     where configurations.id = validation_rules.configuration_id
       and configurations.organization_id = validation_rules.organization_id
       and configurations.deleted_at is null
       and ${visibleTo(viewer)})`;

  return {
    async listForPipeline(validationPipelineId, limit) {
      const rows = await visible()
        .selectAll("validation_rules")
        .where("validation_rules.validation_pipeline_id", "=", validationPipelineId)
        .orderBy("validation_rules.position", "asc")
        .limit(limit)
        .execute();
      return rows.map(toValidationRule);
    },

    async listForVersion(configurationId, versionId) {
      const rows = await visible()
        .selectAll("validation_rules")
        .where("validation_rules.configuration_id", "=", configurationId)
        .where("validation_rules.configuration_version_id", "=", versionId)
        .orderBy("validation_rules.validation_pipeline_id", "asc")
        .orderBy("validation_rules.position", "asc")
        .execute();
      return rows.map(toValidationRule);
    },

    async find(id) {
      const row = await visible().selectAll("validation_rules").where("validation_rules.id", "=", id).executeTakeFirst();
      return row ? toValidationRule(row) : undefined;
    },

    async findInPipeline(validationPipelineId, id) {
      const row = await visible()
        .selectAll("validation_rules")
        .where("validation_rules.id", "=", id)
        .where("validation_rules.validation_pipeline_id", "=", validationPipelineId)
        .executeTakeFirst();
      return row ? toValidationRule(row) : undefined;
    },

    async countInPipeline(validationPipelineId, isApiOwned) {
      let query = scope
        .selectFrom("validation_rules")
        .select((builder) => builder.fn.countAll<string>().as("count"))
        .where("validation_rules.validation_pipeline_id", "=", validationPipelineId);
      if (isApiOwned !== undefined) query = query.where("validation_rules.is_api_owned", "=", isApiOwned);
      const row = await query.executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async create(input) {
      // The next position in the insert itself: under the configuration's
      // lock, so no other insert reads the same largest.
      const nextPosition = sql<number>`(
        select coalesce(max(existing.position), 0) + 1
          from validation_rules existing
         where existing.organization_id = ${context.organizationId}
           and existing.validation_pipeline_id = ${input.validationPipelineId})`;
      const row = await scope
        .insertInto("validation_rules", {
          configuration_id: input.configurationId,
          configuration_version_id: input.versionId,
          validation_pipeline_id: input.validationPipelineId,
          // An expression, which Kysely writes as the value; the scope's types name the column's own.
          position: nextPosition as unknown as number,
          ...contentColumns(input.content),
          name: input.name,
          description: input.description,
          is_api_owned: input.isApiOwned ?? false,
          created_by_user_id: input.createdByUserId,
          created_at: input.at,
          updated_at: input.at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toValidationRule(row);
    },

    async update(id, changes, at) {
      const row = await scope
        .updateTable("validation_rules", {
          ...(changes.content === undefined ? {} : contentColumns(changes.content)),
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          updated_at: at,
        })
        .where("validation_rules.id", "=", id)
        .where(isVisible)
        .returningAll()
        .executeTakeFirst();
      return row ? toValidationRule(row) : undefined;
    },

    async remove(id) {
      const result = await scope
        .deleteFrom("validation_rules")
        .where("validation_rules.id", "=", id)
        .where(isVisible)
        .executeTakeFirst();
      return result.numDeletedRows === 1n;
    },

    async removeApiOwned(validationPipelineId) {
      const rows = await scope
        .deleteFrom("validation_rules")
        .where("validation_rules.validation_pipeline_id", "=", validationPipelineId)
        .where("validation_rules.is_api_owned", "=", true)
        .where(isVisible)
        .returning(["validation_rules.id", "validation_rules.position"])
        .execute();
      return rows.sort((a, b) => a.position - b.position).map((row) => row.id);
    },
  };
}
