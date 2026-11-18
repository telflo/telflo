import {
  RULES_UNAVAILABLE_AT_SAVE_MESSAGE,
  VALIDATION_RULE_LIMIT_MESSAGE,
  validationPipelineExistsMessage,
  type ValidationRulesErrorCode,
} from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The validation pipelines' and rules' own refusals (D15a detail 24). The
 * organization's (`organization_not_found`) and the configurations'
 * (`configuration_not_found`, `configuration_version_not_found`) are those
 * modules', so every endpoint answers them alike. Only 409
 * `validation_pipeline_exists` names a pipeline (decision 24's words), and
 * only 400 `validation_rule_invalid` carries the evaluator's words: both in
 * the response body alone, never a log line (ADR 0024).
 */

/**
 * A validation pipeline the caller can't see: unknown, another version's,
 * another member's draft's, another organization's, or an id that isn't a
 * canonical UUID, all alike.
 */
export function validationPipelineNotFound(): AppError {
  return new AppError(
    "validation_pipeline_not_found" satisfies ValidationRulesErrorCode,
    "Validation pipeline not found",
    404,
  );
}

/** A rule the caller can't see: unknown, another pipeline's, or an id that isn't a canonical UUID, all alike. */
export function validationRuleNotFound(): AppError {
  return new AppError("validation_rule_not_found" satisfies ValidationRulesErrorCode, "Validation rule not found", 404);
}

/** A second validation pipeline for one YAML pipeline on one version: decision 24's words. */
export function validationPipelineExists(pipeline: string): AppError {
  return new AppError(
    "validation_pipeline_exists" satisfies ValidationRulesErrorCode,
    validationPipelineExistsMessage(pipeline),
    409,
  );
}

/** A pipeline's 201st rule (decision 13): decision 24's words. */
export function validationRuleLimitReached(): AppError {
  return new AppError("validation_rule_limit_reached" satisfies ValidationRulesErrorCode, VALIDATION_RULE_LIMIT_MESSAGE, 409);
}

/** The most code points of the evaluator's words a refusal carries (Preflight ruling 20). */
export const VALIDATION_RULE_PROBLEM_MAXIMUM_LENGTH = 1_000;

/** `text` cut to its first `maximum` code points (never splitting a surrogate pair). */
export function firstCodePoints(text: string, maximum: number): string {
  let length = 0;
  let end = 0;
  for (const character of text) {
    if (length === maximum) return text.slice(0, end);
    length += 1;
    end += character.length;
  }
  return text;
}

/** One of the evaluator's problems, as a refusal carries it: the field and its words, cut. */
export interface ValidationRuleProblem {
  field: string;
  message: string;
}

/**
 * The evaluator found the rule broken (decision 6): its words as it words
 * them ("OTTL syntax error: …", "Invalid regex: …", or a problem in its own
 * words; D15a Ruling 33), the first problem's as the message, each problem
 * with its field in `details`, every message cut to
 * VALIDATION_RULE_PROBLEM_MAXIMUM_LENGTH code points. OTTL's parse errors
 * quote the condition, so these words reach the response body alone: the
 * error handler logs no 4xx, and nothing here logs them (ADR 0024).
 */
export function validationRuleInvalid(problems: readonly ValidationRuleProblem[]): AppError {
  const cut = problems.map(({ field, message }) => ({
    field,
    message: firstCodePoints(message, VALIDATION_RULE_PROBLEM_MAXIMUM_LENGTH),
  }));
  return new AppError(
    "validation_rule_invalid" satisfies ValidationRulesErrorCode,
    cut[0]?.message ?? "The rule isn't valid.",
    400,
    { problems: cut },
  );
}

/** The evaluator couldn't check a rule that needs checking (decision 6): unreachable, failing or busy. */
export function rulesUnavailable(): AppError {
  return new AppError("rules_unavailable" satisfies ValidationRulesErrorCode, RULES_UNAVAILABLE_AT_SAVE_MESSAGE, 503);
}

/** More than VALIDATION_RULE_CHECKS_PER_MINUTE_PER_USER checked saves in a minute (decision 16). */
export function validationRuleRateLimited(retryAfterSeconds: number): AppError {
  return new AppError(
    "validation_rule_rate_limited" satisfies ValidationRulesErrorCode,
    "Too many rule checks in the last minute. Try again shortly.",
    429,
    undefined,
    { "retry-after": retryAfterSeconds },
  );
}

/** An OTTL context its pipeline's signal doesn't allow (Preflight ruling 16): the envelope's shared code. */
export function ottlContextNotOfSignal(): AppError {
  return new AppError("invalid_request", "The request was not valid.", 400, [
    { path: ["ottl", "context"], message: "The pipeline's signal doesn't have this OTTL context." },
  ]);
}
