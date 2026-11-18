import {
  isOttlContextOfSignal,
  PUBLIC_VALIDATION_RULE_INVALID_MESSAGE,
  signalOfPipeline,
  VALIDATION_RULES_PER_PIPELINE_MAXIMUM,
  type TestRunSignal,
  type ValidationRuleKind,
  type ValidationRulesErrorCode,
  type ValidationRuleOttl,
  type ValidationRuleTarget,
} from "@telflo/contracts";
import { AppError } from "../../errors.js";
import type { PerUserLimiter } from "../../http/rate-limits.js";
import type { OttlEvaluatorClient, OttlEvaluatorUnavailableReason } from "../../ottl-evaluator/client.js";
import { configurationNotFound, configurationVersionNotFound } from "../configurations/errors.js";
import { lockAsMember, lockedConfiguration } from "../configurations/service.js";
import { assertActiveOrganization, canonicalIdOf, type Actor } from "../organizations/service.js";
import { findTautology } from "../ottl-lint/tautology.js";
import {
  ottlContextNotOfSignal,
  rulesUnavailable,
  validationPipelineExists,
  validationPipelineNotFound,
  validationRuleInvalid,
  validationRuleLimitReached,
  validationRuleNotFound,
  validationRuleRateLimited,
} from "./errors.js";
import type { ValidationPipeline } from "./repositories/validation-pipeline-repository.js";
import type { ValidationRule, ValidationRuleContent } from "./repositories/validation-rule-repository.js";
import type { ValidationPipelinesTransaction, WithValidationPipelinesTransaction } from "./transaction.js";

/*
 * The validation pipelines and rules API (D15a decisions 5, 6, 12, 13, 16
 * and 28; details 24 and 25; Preflight rulings 16, 19 and 20).
 *
 * Validation pipelines and rules belong to a configuration version and
 * follow its configuration's visibility (decision 12): another member's
 * draft's, a deleted configuration's and another organization's are 404,
 * with the configurations' own codes for the configuration and the version,
 * as the suites' are. Anyone who can see the configuration creates, edits
 * and deletes them, on any version, published or not (decision 13).
 *
 * A validation pipeline is one YAML pipeline's, one per version and
 * pipeline (409 `validation_pipeline_exists`), its signal its name's first
 * part. No cap on how many a version has (the owner, decision 28); at most
 * VALIDATION_RULES_PER_PIPELINE_MAXIMUM rules each (409
 * `validation_rule_limit_reached`), counted under the configuration's lock.
 *
 * Saving a rule (its POST and PATCH; Preflight ruling 20), as D13b's
 * validation route asks the collector validator:
 *   1. a read transaction: the membership (under the organization's share
 *      lock, as every read here; no configuration lock), the configuration
 *      and its version, the pipeline, the stored rule (a PATCH), and the
 *      cap's pre-check (a POST). It commits before anything else;
 *   2. an OTTL rule's context must be one its pipeline's signal has (400
 *      `invalid_request`);
 *   3. a check is needed only for a regex or OTTL rule whose checked
 *      content (the pattern; the context, condition and expression)
 *      differs from the stored rule's, as a regex or OTTL rule: a change of
 *      the name, the description, the target, the quantifier or the count
 *      needs none (every stored rule was checked when it was saved). A
 *      builder's canonical OTTL is an OTTL rule, and is checked as one;
 *   4. the person's checked saves (VALIDATION_RULE_CHECKS_PER_MINUTE_PER_USER
 *      a minute in the organization, D14b decision 23), counted when the
 *      evaluator is to be asked and never given back: 429
 *      `validation_rule_rate_limited`;
 *   5. the evaluator's validate, outside any transaction, holding no
 *      connection: a problem is 400 `validation_rule_invalid` with its
 *      words as it words them (Ruling 33), cut to 1,000 code points; an
 *      evaluator unreachable, failing or busy is 503 `rules_unavailable`;
 *   6. the write transaction: the organization as a member, the
 *      configuration locked, the version, the pipeline and the rule re-read,
 *      the cap counted again, the insert at the largest position plus one
 *      or the update, and the audit row.
 *
 * What is written is what the contracts' schemas parsed: the table's blank
 * check is ASCII only, the schemas' Unicode (Ruling 36's watch item).
 *
 * A pipeline's name, a rule's name, description, pattern and OTTL, and the
 * evaluator's words reach no log line and no audit row (ADR 0024): the log
 * names ids and a check's outcome; the audit rows name ids, and a change's
 * fields by name.
 */

export interface ValidationPipelineServiceDependencies {
  withTransaction: WithValidationPipelinesTransaction;
  evaluator: Pick<OttlEvaluatorClient, "validate">;
  /** The person's checked saves in the organization (decision 16). */
  limiter: PerUserLimiter;
  /** Every pipeline and rule timestamp comes from here, never SQL `now()`. */
  now: () => Date;
  log: {
    info(details: Record<string, unknown>, message: string): void;
    warn(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
}

/** The path's ids, as the routes take them: any strings (D5 decision 7). */
export interface VersionPath {
  organizationId: string;
  configurationId: string;
  versionId: string;
}

/** A pipeline's create, as the contract parses it: a name whose first part is a signal. */
export interface CreatePipelineInput {
  pipeline: string;
}

/** A rule's create, as the contract parses it: the kind's own fields only, the name and description trimmed. */
export interface CreateRuleInput {
  kind: ValidationRuleKind;
  target: ValidationRuleTarget;
  pattern?: string | undefined;
  ottl?: ValidationRuleOttl | undefined;
  name: string;
  description: string;
}

/**
 * A rule's change, as the contract parses it: what the rule checks travels
 * whole (`kind` and `target` with the kind's own field), or not at all; a
 * field left out stays as it is.
 */
export interface RuleChanges {
  kind?: ValidationRuleKind | undefined;
  target?: ValidationRuleTarget | undefined;
  pattern?: string | undefined;
  ottl?: ValidationRuleOttl | undefined;
  name?: string | undefined;
  description?: string | undefined;
}

export interface IValidationPipelineService {
  /** The version's validation pipelines the caller can see, oldest first. */
  listPipelines(actor: Actor, path: VersionPath): Promise<ValidationPipeline[]>;
  /** A new validation pipeline for a YAML pipeline: 409 `validation_pipeline_exists` for a second. */
  createPipeline(actor: Actor, path: VersionPath, input: CreatePipelineInput): Promise<ValidationPipeline>;
  /** Deletes a validation pipeline with its rules. */
  removePipeline(actor: Actor, path: VersionPath, validationPipelineId: string): Promise<void>;
  /** The pipeline's rules, in position order. */
  listRules(actor: Actor, path: VersionPath, validationPipelineId: string): Promise<ValidationRule[]>;
  /** A new rule, checked first when it is a regex or OTTL rule (the order above). */
  createRule(actor: Actor, path: VersionPath, validationPipelineId: string, input: CreateRuleInput): Promise<ValidationRule>;
  /**
   * Changes the fields given, checking a regex or OTTL rule's new content
   * first. None given, or none different from what is there, changes and
   * audits nothing, and answers the rule as it is (as a suite's change does).
   */
  updateRule(
    actor: Actor,
    path: VersionPath,
    validationPipelineId: string,
    ruleId: string,
    changes: RuleChanges,
  ): Promise<ValidationRule>;
  /** Deletes a rule; the others keep their positions. */
  removeRule(actor: Actor, path: VersionPath, validationPipelineId: string, ruleId: string): Promise<void>;
  /**
   * The version's validation pipelines the caller can see, oldest first,
   * each with its rules in position order, in one read transaction: the
   * public list (D25 route 13).
   */
  listPipelinesWithRules(actor: Actor, path: VersionPath): Promise<ValidationPipelineWithRules[]>;
  /**
   * The public API's PUT (D25 decision 32, Preflight ruling 8): sets the
   * rules the API owns on the version's validation pipeline for `pipeline`
   * (a name whose first part is a signal; whether the version's text has it
   * is the caller's check), creating the pipeline if it is missing. A
   * person's rules are kept; the API's earlier ones are deleted; the new
   * ones follow every kept rule, marked `is_api_owned`.
   *
   * Every rule is checked first, outside any transaction, as Save checks
   * one (IValidationRuleCheck.checkNewRules: its OTTL context against the
   * pipeline's signal: 400 `invalid_request`; a regex or OTTL rule through
   * the evaluator, the admissions of every call reserved at once: 429 with
   * nothing spent, 400
   * `validation_rule_invalid` in fixed words with the rule's index and the
   * evaluator's problems in `details`, 503 `rules_unavailable`). Then one
   * transaction under the configuration's lock: the pipeline found or
   * created, the API's rules deleted, the kept ones counted with the new
   * ones against the 200 (409 `validation_rule_limit_reached`, nothing
   * written), the new ones inserted. Allowed on a published version, as the
   * Validation tab's saves are.
   */
  replaceApiOwnedRules(
    actor: Actor,
    path: VersionPath,
    pipeline: string,
    rules: readonly CreateRuleInput[],
  ): Promise<ReplacedApiOwnedRules>;
}

/** A validation pipeline with its rules, in position order. */
export interface ValidationPipelineWithRules extends ValidationPipeline {
  rules: ValidationRule[];
}

/** What the public API's PUT did: the pipeline as it now is, and the counts of rules replaced and kept. */
export interface ReplacedApiOwnedRules extends ValidationPipelineWithRules {
  /** The pipeline was created by this call. */
  created: boolean;
  /** The API's earlier rules, deleted. */
  rulesReplaced: number;
  /** A person's rules, left as they were. */
  rulesKept: number;
}

/** The path's configuration and version, canonical, or the 404 each answers for a malformed one. */
function canonicalVersionPath(path: VersionPath): { configurationId: string; versionId: string } {
  const configurationId = canonicalIdOf(path.configurationId);
  if (configurationId === undefined) throw configurationNotFound();
  const versionId = canonicalIdOf(path.versionId);
  if (versionId === undefined) throw configurationVersionNotFound();
  return { configurationId, versionId };
}

/**
 * A read's checks: the membership, re-read under the organization's share
 * lock, then the configuration and its version as the caller sees them (404
 * `configuration_not_found`, then `configuration_version_not_found`).
 */
async function visibleVersion(
  transaction: ValidationPipelinesTransaction,
  actor: Actor,
  configurationId: string,
  versionId: string,
): Promise<void> {
  await lockAsMember(transaction, actor);
  if (!(await transaction.configurations.find(configurationId))) throw configurationNotFound();
  if (!(await transaction.versions.findSummary(configurationId, versionId))) throw configurationVersionNotFound();
}

/** A write's checks, in the one lock order: the organization as a member, then the configuration `for update`, then its version. */
async function lockedVersion(
  transaction: ValidationPipelinesTransaction,
  actor: Actor,
  configurationId: string,
  versionId: string,
): Promise<void> {
  await lockAsMember(transaction, actor);
  await lockedConfiguration(transaction, configurationId);
  if (!(await transaction.versions.findSummary(configurationId, versionId))) throw configurationVersionNotFound();
}

/** The version's pipeline the caller can see, or 404 `validation_pipeline_not_found` (a malformed id included). */
async function pipelineIn(
  transaction: ValidationPipelinesTransaction,
  configurationId: string,
  versionId: string,
  validationPipelineId: string | undefined,
): Promise<ValidationPipeline> {
  const pipeline =
    validationPipelineId === undefined
      ? undefined
      : await transaction.pipelines.findInVersion(configurationId, versionId, validationPipelineId);
  if (!pipeline) throw validationPipelineNotFound();
  return pipeline;
}

/** The pipeline's rule the caller can see, or 404 `validation_rule_not_found` (a malformed id included). */
async function ruleIn(
  transaction: ValidationPipelinesTransaction,
  validationPipelineId: string,
  ruleId: string | undefined,
): Promise<ValidationRule> {
  const rule = ruleId === undefined ? undefined : await transaction.rules.findInPipeline(validationPipelineId, ruleId);
  if (!rule) throw validationRuleNotFound();
  return rule;
}

/** A create's or a change's content, as stored: an OTTL rule's OTTL and no pattern, or a pattern and no OTTL. */
export function contentOf(rule: {
  kind: ValidationRuleKind;
  target: ValidationRuleTarget;
  pattern?: string | null | undefined;
  ottl?: ValidationRuleOttl | null | undefined;
}): ValidationRuleContent {
  return rule.kind === "ottl"
    ? { kind: rule.kind, target: rule.target, pattern: null, ottl: rule.ottl ?? null }
    : { kind: rule.kind, target: rule.target, pattern: rule.pattern ?? null, ottl: null };
}

const isRegexKind = (kind: ValidationRuleKind) => kind === "contains_regex" || kind === "not_contains_regex";

/** Two OTTL objects' fields, field by field (an absent field and its column's null alike). */
function sameOttl(a: ValidationRuleOttl | null, b: ValidationRuleOttl | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.context === b.context &&
    a.quantifier === b.quantifier &&
    (a.condition ?? null) === (b.condition ?? null) &&
    (a.expression ?? null) === (b.expression ?? null) &&
    (a.count?.operator ?? null) === (b.count?.operator ?? null) &&
    (a.count?.value ?? null) === (b.count?.value ?? null) &&
    (a.count?.value2 ?? null) === (b.count?.value2 ?? null)
  );
}

/**
 * Whether saving `content` needs the evaluator (Preflight ruling 20): a
 * regex rule whose pattern isn't the stored regex rule's, or an OTTL rule
 * whose context, condition or expression isn't the stored OTTL rule's. A
 * new rule (`stored` undefined) of either kind always does; a text rule
 * never does.
 */
export function needsCheck(content: ValidationRuleContent, stored: ValidationRuleContent | undefined): boolean {
  if (isRegexKind(content.kind)) {
    return stored === undefined || !isRegexKind(stored.kind) || stored.pattern !== content.pattern;
  }
  if (content.kind === "ottl") {
    if (stored === undefined || stored.kind !== "ottl" || stored.ottl === null || content.ottl === null) return true;
    return (
      stored.ottl.context !== content.ottl.context ||
      (stored.ottl.condition ?? null) !== (content.ottl.condition ?? null) ||
      (stored.ottl.expression ?? null) !== (content.ottl.expression ?? null)
    );
  }
  return false;
}

/** The content fields that differ, by name: what an update's audit row names (never their values). */
function changedContentFields(from: ValidationRuleContent, to: ValidationRuleContent): string[] {
  const fields: string[] = [];
  if (from.kind !== to.kind) fields.push("kind");
  if (from.target !== to.target) fields.push("target");
  if (from.pattern !== to.pattern) fields.push("pattern");
  if (!sameOttl(from.ottl, to.ottl)) fields.push("ottl");
  return fields;
}

/** An OTTL rule's context must be one its pipeline's signal has (Preflight ruling 16): 400 `invalid_request`. */
function assertContextOfSignal(content: ValidationRuleContent, signal: TestRunSignal): void {
  if (content.kind === "ottl" && content.ottl !== null && !isOttlContextOfSignal(content.ottl.context, signal)) {
    throw ottlContextNotOfSignal();
  }
}

/**
 * The reasons that mean a deployment to fix rather than a moment's trouble:
 * logged at error, as D13b's validation logs the validator's.
 */
const MISCONFIGURATION_REASONS: ReadonlySet<OttlEvaluatorUnavailableReason> = new Set([
  "unauthorized",
  "invalid_request",
  "malformed_reply",
]);

/** What the rule check is built from: the service's evaluator, limiter and log. */
export type ValidationRuleCheckDependencies = Pick<ValidationPipelineServiceDependencies, "evaluator" | "limiter" | "log">;

/**
 * Save's check of a rule (steps 2 to 5 above), shared by the service's
 * saves, the public API's PUT and D25's test runs with inline rules
 * (decision 42), so a rule is checked the one way wherever it comes from.
 */
export interface IValidationRuleCheck {
  /**
   * Steps 4 and 5: the person's limit, then the evaluator's check, outside
   * any transaction. Resolves when the rule is valid; throws its refusal
   * otherwise (429 `validation_rule_rate_limited`, 400
   * `validation_rule_invalid` in the evaluator's words, 503
   * `rules_unavailable`). `ids` are what the log names: ids only.
   */
  check(actor: Actor, signal: TestRunSignal, content: ValidationRuleContent, ids: Record<string, string>): Promise<void>;
  /**
   * A new rule as Save checks one (steps 2 to 5): its OTTL context against
   * `signal` (400 `invalid_request`), then `check` when its kind needs one
   * (a regex or OTTL rule). Answers its content, as stored.
   */
  checkNewRule(
    actor: Actor,
    signal: TestRunSignal,
    rule: CreateRuleInput,
    ids: Record<string, string>,
  ): Promise<ValidationRuleContent>;
  /**
   * The public surface's batch of new rules (D25: the validation pipelines'
   * PUT, a test run's inline rules), each checked as Save checks one, with
   * their checks reserved together (Ruling 172):
   *   1. every rule's OTTL context against `signal`, before anything is
   *      spent (400 `invalid_request` at `rules[i].ottl.context`), then
   *      every OTTL condition that can't fail or can't pass (findTautology,
   *      the guard on the API's rules; D25 Ruling 178): 400
   *      `validation_rule_invalid` with `details.ruleIndex` and the check's
   *      fixed words in `problems` (field `ottl.condition`), nothing spent.
   *      The Validation tab's Save (`checkNewRule`) doesn't run it (D15a);
   *   2. one `validationRuleChecksPerUser` admission for each regex or OTTL
   *      rule, all at once: if the person's limit can't take them all, none
   *      is kept (each admitted one is refunded) and the batch answers 429
   *      `validation_rule_rate_limited`, nothing spent;
   *   3. the evaluator asked for each, in order; at the first refusal the
   *      admissions of the rules not yet asked are refunded, and a rule the
   *      evaluator finds broken answers 400 `validation_rule_invalid` in
   *      fixed words (decision 20) with `details.ruleIndex` and the
   *      evaluator's `problems`; a 503 passes through as it is.
   * Answers the rules' contents, as stored, in order.
   */
  checkNewRules(
    actor: Actor,
    signal: TestRunSignal,
    rules: readonly CreateRuleInput[],
    ids: Record<string, string>,
  ): Promise<ValidationRuleContent[]>;
}

export function createValidationRuleCheck(deps: ValidationRuleCheckDependencies): IValidationRuleCheck {
  const { evaluator, limiter, log } = deps;

  /**
   * Steps 4 and 5: the person's limit, then the evaluator's check, outside
   * any transaction. Resolves when the rule is valid; throws its refusal
   * otherwise. `ids` are what the log names: ids only.
   */
  async function check(
    actor: Actor,
    signal: TestRunSignal,
    content: ValidationRuleContent,
    ids: Record<string, string>,
  ): Promise<void> {
    const admission = limiter.admit(actor.context.userId, actor.context.organizationId);
    if (!admission.isAdmitted) throw validationRuleRateLimited(admission.retryAfterSeconds);
    // Counted now that the evaluator is asked, and never given back (Preflight ruling 20).
    await evaluate(signal, content, ids);
  }

  /** Step 5 alone: the evaluator's check of an admitted rule. Resolves when it is valid; throws its refusal otherwise. */
  async function evaluate(signal: TestRunSignal, content: ValidationRuleContent, ids: Record<string, string>): Promise<void> {
    const result = await evaluator.validate({
      signal,
      rule: { kind: content.kind, target: content.target, pattern: content.pattern, ottl: content.ottl },
    });
    if (result.kind === "valid") {
      log.info({ ...ids, kind: content.kind, result: "valid" }, "validation rule checked");
      return;
    }
    if (result.kind === "invalid") {
      // The evaluator's words quote the rule (OTTL's parse errors quote the
      // condition): the response body alone carries them, never this line.
      log.info({ ...ids, kind: content.kind, result: "invalid" }, "validation rule checked");
      throw validationRuleInvalid(result.problems);
    }
    if (result.kind === "busy") {
      log.warn({ ...ids, kind: content.kind, result: "busy" }, "the OTTL evaluator is busy");
      throw rulesUnavailable();
    }
    const fields = {
      ...ids,
      kind: content.kind,
      result: "unavailable",
      reason: result.reason,
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.code === undefined ? {} : { code: result.code }),
    };
    if (MISCONFIGURATION_REASONS.has(result.reason)) log.error(fields, "the OTTL evaluator can't be used");
    else log.warn(fields, "the OTTL evaluator is unavailable");
    throw rulesUnavailable();
  }

  return {
    check,
    async checkNewRule(actor, signal, rule, ids) {
      const content = contentOf(rule);
      assertContextOfSignal(content, signal);
      if (needsCheck(content, undefined)) await check(actor, signal, content, ids);
      return content;
    },
    async checkNewRules(actor, signal, rules, ids) {
      const contents = rules.map(contentOf);
      // 1. Every rule's OTTL context before any check is spent, its index in the refusal.
      for (const [index, content] of contents.entries()) {
        if (content.kind === "ottl" && content.ottl !== null && !isOttlContextOfSignal(content.ottl.context, signal)) {
          throw ruleContextNotOfSignal(index);
        }
      }
      // 1b. Every OTTL condition able to fail and to pass (D25 Ruling 178:
      // the guard on the API's rules), before any check is spent.
      // The tautology check's words are fixed (no rule text).
      for (const [index, content] of contents.entries()) {
        const { ottl } = content;
        const tautology = ottl?.condition === undefined ? null : findTautology(ottl.condition, ottl.quantifier);
        if (tautology !== null) {
          throw new AppError(
            "validation_rule_invalid" satisfies ValidationRulesErrorCode,
            PUBLIC_VALIDATION_RULE_INVALID_MESSAGE,
            400,
            { ruleIndex: index, problems: [{ field: "ottl.condition", message: tautology }] },
          );
        }
      }
      // 2. Every check reserved at once, synchronously, so no other request's admission interleaves.
      const checked = [...contents.keys()].filter((index) => needsCheck(contents[index]!, undefined));
      const refunds: Array<() => void> = [];
      for (const _index of checked) {
        const admission = limiter.admit(actor.context.userId, actor.context.organizationId);
        if (!admission.isAdmitted) {
          for (const refund of refunds) refund();
          throw validationRuleRateLimited(admission.retryAfterSeconds);
        }
        refunds.push(admission.refund);
      }
      // 3. Each asked in order; the admissions of the rules not reached are given back.
      for (const [place, index] of checked.entries()) {
        try {
          await evaluate(signal, contents[index]!, ids);
        } catch (error) {
          for (const refund of refunds.slice(place + 1)) refund();
          throw publicRuleRefusal(error, index);
        }
      }
      return contents;
    },
  };
}

export function createValidationPipelineService(deps: ValidationPipelineServiceDependencies): IValidationPipelineService {
  const { withTransaction, evaluator, limiter, now, log } = deps;

  /** An audit row about a pipeline or a rule, in the active organization: ids only. */
  function audit(
    actor: Actor,
    action: string,
    subject: { type: "validation_pipeline" | "validation_rule"; id: string },
    metadata: Record<string, unknown>,
  ) {
    return {
      action,
      actorUserId: actor.context.userId,
      actorEmail: actor.email,
      organizationId: actor.context.organizationId,
      subjectType: subject.type,
      subjectId: subject.id,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    };
  }

  const { check, checkNewRules } = createValidationRuleCheck({ evaluator, limiter, log });

  return {
    async listPipelines(actor, path) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      return withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, configurationId, versionId);
        return transaction.pipelines.listForVersion(configurationId, versionId);
      });
    },

    async createPipeline(actor, path, input) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const signal = signalOfPipeline(input.pipeline);
      // The contract refuses a name whose first part isn't a signal.
      if (signal === undefined) throw new Error("a validation pipeline's name must start with its signal");
      return withTransaction(actor.context, async (transaction) => {
        await lockedVersion(transaction, actor, configurationId, versionId);
        // Under the configuration's lock, which every create takes: the unique key is the backstop.
        if (await transaction.pipelines.findByName(configurationId, versionId, input.pipeline)) {
          throw validationPipelineExists(input.pipeline);
        }
        const pipeline = await transaction.pipelines.create({
          configurationId,
          versionId,
          pipeline: input.pipeline,
          signal,
          createdByUserId: actor.context.userId,
          at: now(),
        });
        if (!pipeline) throw validationPipelineExists(input.pipeline);
        await transaction.audit.record(
          audit(actor, "validation_pipeline.created", { type: "validation_pipeline", id: pipeline.id }, {
            configurationId,
            versionId,
          }),
        );
        return pipeline;
      });
    },

    async removePipeline(actor, path, validationPipelineId) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const id = canonicalIdOf(validationPipelineId);
      await withTransaction(actor.context, async (transaction) => {
        await lockedVersion(transaction, actor, configurationId, versionId);
        const pipeline = await pipelineIn(transaction, configurationId, versionId, id);
        // Visible under the lock just taken: this can't miss.
        if (!(await transaction.pipelines.remove(pipeline.id))) throw validationPipelineNotFound();
        await transaction.audit.record(
          audit(actor, "validation_pipeline.deleted", { type: "validation_pipeline", id: pipeline.id }, {
            configurationId,
            versionId,
          }),
        );
      });
    },

    async listRules(actor, path, validationPipelineId) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const id = canonicalIdOf(validationPipelineId);
      return withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, configurationId, versionId);
        const pipeline = await pipelineIn(transaction, configurationId, versionId, id);
        return transaction.rules.listForPipeline(pipeline.id, VALIDATION_RULES_PER_PIPELINE_MAXIMUM);
      });
    },

    async createRule(actor, path, validationPipelineId, input) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const id = canonicalIdOf(validationPipelineId);
      const content = contentOf(input);

      // 1. Read in one transaction, committed before the evaluator is asked.
      const pipeline = await withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, configurationId, versionId);
        const found = await pipelineIn(transaction, configurationId, versionId, id);
        // The cap's pre-check: a 201st is refused before it spends a check.
        if ((await transaction.rules.countInPipeline(found.id)) >= VALIDATION_RULES_PER_PIPELINE_MAXIMUM) {
          throw validationRuleLimitReached();
        }
        return found;
      });

      // 2–5. The context, then the check when the kind needs one.
      assertContextOfSignal(content, pipeline.signal);
      if (needsCheck(content, undefined)) {
        await check(actor, pipeline.signal, content, { configurationId, versionId, validationPipelineId: pipeline.id });
      }

      // 6. One transaction, under the locks: the rule and the audit.
      return withTransaction(actor.context, async (transaction) => {
        await lockedVersion(transaction, actor, configurationId, versionId);
        const locked = await pipelineIn(transaction, configurationId, versionId, pipeline.id);
        if ((await transaction.rules.countInPipeline(locked.id)) >= VALIDATION_RULES_PER_PIPELINE_MAXIMUM) {
          throw validationRuleLimitReached();
        }
        const rule = await transaction.rules.create({
          configurationId,
          versionId,
          validationPipelineId: locked.id,
          content,
          name: input.name,
          description: input.description,
          createdByUserId: actor.context.userId,
          at: now(),
        });
        await transaction.audit.record(
          audit(actor, "validation_rule.created", { type: "validation_rule", id: rule.id }, {
            configurationId,
            versionId,
            validationPipelineId: locked.id,
          }),
        );
        return rule;
      });
    },

    async updateRule(actor, path, validationPipelineId, ruleId, changes) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const id = canonicalIdOf(validationPipelineId);
      const key = canonicalIdOf(ruleId);
      // What the rule checks travels whole: the contract's PATCH schema
      // (UpdateValidationRuleRequestSchema) takes `kind` and `target`
      // together, with the kind's own fields, or none of them, so a body
      // naming one alone is a 400 before this runs. The content is built
      // only when both are present; otherwise the stored content stays as it
      // is and nothing is checked (Ruling 39).
      const content =
        changes.kind !== undefined && changes.target !== undefined
          ? contentOf({ kind: changes.kind, target: changes.target, pattern: changes.pattern, ottl: changes.ottl })
          : undefined;

      // 1. Read in one transaction, committed before the evaluator is asked.
      const { pipeline, stored } = await withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, configurationId, versionId);
        const found = await pipelineIn(transaction, configurationId, versionId, id);
        return { pipeline: found, stored: await ruleIn(transaction, found.id, key) };
      });

      // 2–5. The context, then the check when the checked content changed.
      if (content !== undefined) {
        assertContextOfSignal(content, pipeline.signal);
        if (needsCheck(content, stored)) {
          await check(actor, pipeline.signal, content, {
            configurationId,
            versionId,
            validationPipelineId: pipeline.id,
            ruleId: stored.id,
          });
        }
      }

      // 6. One transaction, under the locks: the change and the audit.
      return withTransaction(actor.context, async (transaction) => {
        await lockedVersion(transaction, actor, configurationId, versionId);
        const locked = await pipelineIn(transaction, configurationId, versionId, pipeline.id);
        const current = await ruleIn(transaction, locked.id, stored.id);
        // Only the fields that differ from what is there, as a suite's change.
        const to: { content?: ValidationRuleContent; name?: string; description?: string } = {};
        const changedFields: string[] = [];
        if (content !== undefined) {
          const contentFields = changedContentFields(current, content);
          if (contentFields.length > 0) {
            to.content = content;
            changedFields.push(...contentFields);
          }
        }
        if (changes.name !== undefined && changes.name !== current.name) {
          to.name = changes.name;
          changedFields.push("name");
        }
        if (changes.description !== undefined && changes.description !== current.description) {
          to.description = changes.description;
          changedFields.push("description");
        }
        if (changedFields.length === 0) return current;
        const updated = await transaction.rules.update(current.id, to, now());
        // Visible under the lock just taken: this can't miss.
        if (!updated) throw validationRuleNotFound();
        // The fields' names, never their values (ADR 0024).
        await transaction.audit.record(
          audit(actor, "validation_rule.updated", { type: "validation_rule", id: current.id }, {
            configurationId,
            versionId,
            validationPipelineId: locked.id,
            changedFields,
          }),
        );
        return updated;
      });
    },

    async removeRule(actor, path, validationPipelineId, ruleId) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const id = canonicalIdOf(validationPipelineId);
      const key = canonicalIdOf(ruleId);
      await withTransaction(actor.context, async (transaction) => {
        await lockedVersion(transaction, actor, configurationId, versionId);
        const pipeline = await pipelineIn(transaction, configurationId, versionId, id);
        const rule = await ruleIn(transaction, pipeline.id, key);
        // Visible under the lock just taken: this can't miss.
        if (!(await transaction.rules.remove(rule.id))) throw validationRuleNotFound();
        await transaction.audit.record(
          audit(actor, "validation_rule.deleted", { type: "validation_rule", id: rule.id }, {
            configurationId,
            versionId,
            validationPipelineId: pipeline.id,
          }),
        );
      });
    },

    async listPipelinesWithRules(actor, path) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      return withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, configurationId, versionId);
        const pipelines = await transaction.pipelines.listForVersion(configurationId, versionId);
        const rules = await transaction.rules.listForVersion(configurationId, versionId);
        const byPipeline = new Map<string, ValidationRule[]>(pipelines.map((pipeline) => [pipeline.id, []]));
        for (const rule of rules) byPipeline.get(rule.validationPipelineId)?.push(rule);
        return pipelines.map((pipeline) => ({ ...pipeline, rules: byPipeline.get(pipeline.id) ?? [] }));
      });
    },

    async replaceApiOwnedRules(actor, path, pipelineName, rules) {
      assertActiveOrganization(actor, path.organizationId);
      const { configurationId, versionId } = canonicalVersionPath(path);
      const signal = signalOfPipeline(pipelineName);
      // The route refuses a name whose first part isn't the body's signal.
      if (signal === undefined) throw new Error("a validation pipeline's name must start with its signal");

      // 1. Read in one transaction, committed before the evaluator is asked:
      // the version as the caller sees it, and the cap's pre-check, so a PUT
      // that can't fit spends no check.
      await withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, configurationId, versionId);
        const found = await transaction.pipelines.findByName(configurationId, versionId, pipelineName);
        const kept = found === undefined ? 0 : await transaction.rules.countInPipeline(found.id, false);
        if (kept + rules.length > VALIDATION_RULES_PER_PIPELINE_MAXIMUM) throw validationRuleLimitReached();
      });

      // 2–5. Every rule's context, then all their checks reserved at once and asked in order (checkNewRules).
      const contents = await checkNewRules(actor, signal, rules, { configurationId, versionId });

      // 6. One transaction, under the locks: the pipeline, the API's rules replaced, and the audit.
      return withTransaction(actor.context, async (transaction) => {
        await lockedVersion(transaction, actor, configurationId, versionId);
        const at = now();
        let pipeline = await transaction.pipelines.findByName(configurationId, versionId, pipelineName);
        const created = pipeline === undefined;
        if (pipeline === undefined) {
          pipeline = await transaction.pipelines.create({
            configurationId,
            versionId,
            pipeline: pipelineName,
            signal,
            createdByUserId: actor.context.userId,
            at,
          });
          // Under the configuration's lock, which every create takes: no other create can have won.
          if (pipeline === undefined) throw new Error("the validation pipeline appeared under the configuration's lock");
          await transaction.audit.record(
            audit(actor, "validation_pipeline.created", { type: "validation_pipeline", id: pipeline.id }, {
              configurationId,
              versionId,
            }),
          );
        }
        const deletedRuleIds = await transaction.rules.removeApiOwned(pipeline.id);
        const rulesReplaced = deletedRuleIds.length;
        const rulesKept = await transaction.rules.countInPipeline(pipeline.id);
        // Again under the lock: a person may have added rules since the pre-check.
        if (rulesKept + rules.length > VALIDATION_RULES_PER_PIPELINE_MAXIMUM) throw validationRuleLimitReached();
        const addedRuleIds: string[] = [];
        for (const [index, rule] of rules.entries()) {
          const added = await transaction.rules.create({
            configurationId,
            versionId,
            validationPipelineId: pipeline.id,
            content: contents[index]!,
            name: rule.name,
            description: rule.description,
            createdByUserId: actor.context.userId,
            at,
            isApiOwned: true,
          });
          addedRuleIds.push(added.id);
        }
        // Ids and counts only (ADR 0024): one row for the replacement, naming the rules it deleted and added.
        await transaction.audit.record(
          audit(actor, "validation_pipeline.rules_replaced", { type: "validation_pipeline", id: pipeline.id }, {
            configurationId,
            versionId,
            rulesReplaced,
            rulesAdded: rules.length,
            rulesKept,
            deletedRuleIds,
            addedRuleIds,
          }),
        );
        const saved = await transaction.rules.listForPipeline(pipeline.id, VALIDATION_RULES_PER_PIPELINE_MAXIMUM);
        return { ...pipeline, rules: saved, created, rulesReplaced, rulesKept };
      });
    },
  };
}

/**
 * The public PUT's refusal for an OTTL context its pipeline's signal
 * doesn't have (Preflight ruling 16's, with the rule's place in the body):
 * 400 `invalid_request`.
 */
function ruleContextNotOfSignal(index: number): AppError {
  return new AppError("invalid_request", "The request was not valid.", 400, [
    { path: ["rules", index, "ottl", "context"], message: "The pipeline's signal doesn't have this OTTL context." },
  ]);
}

/**
 * The public PUT's form of a rule's refusal by the evaluator (D25 decision
 * 20: messages are fixed words, never a rule or a downstream service's
 * text): `validation_rule_invalid` keeps its code and status, its message
 * becomes fixed words, and its details name the rule's place in the body
 * with the evaluator's problems (which quote the rule: the reply's body
 * alone carries them, as the Validation tab's). Any other refusal passes
 * through as it is.
 */
function publicRuleRefusal(error: unknown, index: number): unknown {
  if (!(error instanceof AppError) || error.code !== ("validation_rule_invalid" satisfies ValidationRulesErrorCode)) return error;
  const problems = (error.details as { problems?: unknown } | undefined)?.problems ?? [];
  return new AppError(error.code, PUBLIC_VALIDATION_RULE_INVALID_MESSAGE, error.statusCode, { ruleIndex: index, problems });
}
