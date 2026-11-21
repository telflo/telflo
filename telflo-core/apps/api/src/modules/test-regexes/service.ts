import type { PerUserLimiter } from "../../http/rate-limits.js";
import type { OttlEvaluatorClient, OttlEvaluatorUnavailableReason } from "../../ottl-evaluator/client.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import { canonicalIdOf } from "../organizations/service.js";
import { rulesUnavailable, validationRuleRateLimited } from "../validation-pipelines/errors.js";
import { testRegexInvalid, testRegexNameTaken, testRegexNotFound } from "./errors.js";
import {
  TestRegexNameTakenError,
  type ITestRegexRepository,
  type TestRegex,
  type TestRegexChanges,
} from "./repositories/test-regex-repository.js";

/*
 * The regex library's API: named regex patterns, global as test templates
 * are.
 *
 * Whether the caller may write is decided before the service is reached
 * (`requireProductAdmin` on the routes); every write is audited in no
 * organization, with ids only.
 *
 * A create, in order: the body (the contract's, 400); the name read (409
 * `test_regex_name_taken`, so a duplicate spends no check); the person's
 * checked saves (429); the evaluator's RE2 check, outside any transaction
 * (400 `test_regex_invalid`, 503 `rules_unavailable`); then one
 * transaction: the insert (a name taken meanwhile is 23505 on
 * uq_test_regex_name: 409) and the audit row.
 *
 * A change, in order: the id (404 for one that isn't a canonical UUID); the
 * entry (404); a check only when the regex is sent and differs from the
 * stored one (then the limit and the evaluator, as a create's); then one
 * transaction: the entry locked, the fields that differ from the locked row
 * written (a name taken is 409 from the unique index), and the audit row
 * naming them. None differ, or none were sent: the entry as it is, no write
 * and no audit. A regex written is always one the evaluator took: either
 * this request's, checked, or the one already stored when the request
 * began, checked when it was saved.
 *
 * The check: the evaluator's validate with a `contains_regex` rule over
 * `output` on `logs` (RE2 answers a regex alike for every signal and target),
 * counted on the person's own checked saves (`admit(userId, null)`:
 * VALIDATION_RULE_CHECKS_PER_MINUTE_PER_USER a minute, apart from every
 * organization's count of rule saves), when the evaluator is to be asked, and
 * never given back.
 *
 * An entry's name, category, description and regex, and the evaluator's
 * words, reach no log line and no audit row: a log line names
 * the entry's id (once it has one) and the check's result, and an
 * unavailable one the client's reason, status and the envelope's code, as
 * the rules' check, nothing else.
 */

/** The repositories a write uses, bound to one transaction. Both are global: no database context is needed. */
export interface TestRegexesTransaction {
  testRegexes: ITestRegexRepository;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one database transaction and resolves with its result once
 * it commits. If `work` rejects, the transaction rolls back and the
 * rejection propagates.
 */
export type WithTestRegexesTransaction = <Result>(work: (transaction: TestRegexesTransaction) => Promise<Result>) => Promise<Result>;

export interface TestRegexServiceDependencies {
  /** The reads' repository, outside any transaction: each read is one statement. */
  testRegexes: Pick<ITestRegexRepository, "list" | "find" | "findByName">;
  withTransaction: WithTestRegexesTransaction;
  evaluator: Pick<OttlEvaluatorClient, "validate">;
  /** The person's checked saves, alone (`admit(userId, null)`). */
  limiter: PerUserLimiter;
  /** Every entry timestamp comes from here, never SQL `now()`. */
  now: () => Date;
  log: {
    info(details: Record<string, unknown>, message: string): void;
    warn(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
}

/** Who writes, for the audit row and the limit: a product admin, never acting for an organization. */
export interface TestRegexWriter {
  userId: string;
  email: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** A create, as the contract parses it: trimmed, the description null for none, the regex as sent. */
export interface TestRegexToCreate {
  name: string;
  category: string;
  description: string | null;
  regex: string;
}

/** A change, as the contract parses it: a field left out stays as it is. */
export type TestRegexUpdate = { [Field in keyof TestRegexChanges]?: TestRegexChanges[Field] | undefined };

export interface ITestRegexService {
  /** Every entry, by category, then name, then id. */
  list(): Promise<TestRegex[]>;
  /** Checks and saves a new entry: 409, 429, 400 or 503 otherwise (the module's comment says in which order). */
  create(writer: TestRegexWriter, input: TestRegexToCreate): Promise<TestRegex>;
  /** Changes the fields given that differ; a changed regex is checked first. 404 `test_regex_not_found` for an unknown or malformed id. */
  update(writer: TestRegexWriter, id: string, changes: TestRegexUpdate): Promise<TestRegex>;
  /** Deletes it for good. 404 `test_regex_not_found` otherwise. */
  remove(writer: TestRegexWriter, id: string): Promise<void>;
}

/** The fields a change compares and audits, in the contract's order. */
const FIELDS = ["name", "category", "description", "regex"] as const satisfies readonly (keyof TestRegexChanges)[];

/**
 * The reasons that mean a deployment to fix rather than a moment's trouble:
 * logged at error, as the rules' check logs them (the client logs their
 * detail itself).
 */
const MISCONFIGURATION_REASONS: ReadonlySet<OttlEvaluatorUnavailableReason> = new Set([
  "unauthorized",
  "invalid_request",
  "malformed_reply",
]);

/** An audit row about an entry: global, so in no organization; ids and field names only. */
function auditEvent(writer: TestRegexWriter, testRegexId: string, action: string, metadata: Record<string, unknown>): AuditEvent {
  return {
    action,
    actorUserId: writer.userId,
    actorEmail: writer.email,
    subjectType: "test_regex",
    subjectId: testRegexId,
    metadata,
    ipAddress: writer.ipAddress,
    userAgent: writer.userAgent,
  };
}

export function createTestRegexService(deps: TestRegexServiceDependencies): ITestRegexService {
  const { testRegexes, withTransaction, evaluator, limiter, now, log } = deps;

  /**
   * The person's limit, then the evaluator's RE2, outside any transaction.
   * Resolves when the regex is valid; throws its refusal otherwise. `ids`
   * are what the log names: the entry's id, when it has one.
   */
  async function check(writer: TestRegexWriter, regex: string, ids: { testRegexId?: string }): Promise<void> {
    const admission = limiter.admit(writer.userId, null);
    if (!admission.isAdmitted) throw validationRuleRateLimited(admission.retryAfterSeconds);
    // Counted now that the evaluator is asked, and never given back.
    const result = await evaluator.validate({
      signal: "logs",
      rule: { kind: "contains_regex", target: "output", pattern: regex },
    });
    if (result.kind === "valid") {
      log.info({ ...ids, result: "valid" }, "test regex checked");
      return;
    }
    if (result.kind === "invalid") {
      // The evaluator's words quote the regex: the response body alone carries them.
      log.info({ ...ids, result: "invalid" }, "test regex checked");
      throw testRegexInvalid(result.problems);
    }
    if (result.kind === "busy") {
      log.warn({ ...ids, result: "busy" }, "the OTTL evaluator is busy");
      throw rulesUnavailable();
    }
    // The reason, the status and the envelope's code (the contract's fixed list), as the rules' check logs them; never the body.
    const fields = {
      ...ids,
      result: "unavailable",
      reason: result.reason,
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.code === undefined ? {} : { code: result.code }),
    };
    if (MISCONFIGURATION_REASONS.has(result.reason)) log.error(fields, "the OTTL evaluator can't be used");
    else log.warn(fields, "the OTTL evaluator is unavailable");
    throw rulesUnavailable();
  }

  /** `write`, with the unique index's name clash as 409 `test_regex_name_taken`. */
  async function nameClashAs409<Result>(write: () => Promise<Result>): Promise<Result> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof TestRegexNameTakenError) throw testRegexNameTaken();
      throw error;
    }
  }

  return {
    async list() {
      return testRegexes.list();
    },

    async create(writer, input) {
      // Before the check, so a duplicate spends none; the unique index is the backstop.
      if (await testRegexes.findByName(input.name)) throw testRegexNameTaken();
      await check(writer, input.regex, {});
      return nameClashAs409(() =>
        withTransaction(async (transaction) => {
          const created = await transaction.testRegexes.create({ ...input, at: now() });
          await transaction.audit.record(auditEvent(writer, created.id, "test_regex.created", {}));
          return created;
        }),
      );
    },

    async update(writer, id, changes) {
      const testRegexId = canonicalIdOf(id);
      if (testRegexId === undefined) throw testRegexNotFound();
      const stored = await testRegexes.find(testRegexId);
      if (!stored) throw testRegexNotFound();
      // Only a regex that differs is checked: a stored one was checked when it was saved.
      if (changes.regex !== undefined && changes.regex !== stored.regex) await check(writer, changes.regex, { testRegexId });
      return nameClashAs409(() =>
        withTransaction(async (transaction) => {
          const current = await transaction.testRegexes.lock(testRegexId);
          // Deleted since it was read.
          if (!current) throw testRegexNotFound();
          // Only the fields that differ from what is there now, as a template's change.
          const to: TestRegexChanges = {};
          for (const field of FIELDS) {
            const value = changes[field];
            if (value !== undefined && value !== current[field]) Object.assign(to, { [field]: value });
          }
          const changedFields = FIELDS.filter((field) => field in to);
          if (changedFields.length === 0) return current;
          const updated = await transaction.testRegexes.update(current.id, to, now());
          // Locked above, and only a delete in another transaction ends it: this can't miss.
          if (!updated) throw testRegexNotFound();
          // The fields' names, never their values.
          await transaction.audit.record(auditEvent(writer, current.id, "test_regex.updated", { changedFields }));
          return updated;
        }),
      );
    },

    async remove(writer, id) {
      const testRegexId = canonicalIdOf(id);
      if (testRegexId === undefined) throw testRegexNotFound();
      await withTransaction(async (transaction) => {
        if (!(await transaction.testRegexes.remove(testRegexId))) throw testRegexNotFound();
        await transaction.audit.record(auditEvent(writer, testRegexId, "test_regex.deleted", {}));
      });
    },
  };
}
