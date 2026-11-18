import { TEST_REGEX_NAME_TAKEN_MESSAGE, type TestRegexErrorCode } from "@telflo/contracts";
import { AppError } from "../../errors.js";
import { firstCodePoints, VALIDATION_RULE_PROBLEM_MAXIMUM_LENGTH, type ValidationRuleProblem } from "../validation-pipelines/errors.js";

/*
 * The regex library's own refusals (D15b detail 17; Preflight ruling 4).
 * Its check's are the rules' check's, from validation-pipelines/errors.ts:
 * 503 `rules_unavailable` and 429 `validation_rule_rate_limited`, in their
 * words. No message names an entry; only 400 `test_regex_invalid` carries
 * the evaluator's words, which quote the regex: in the response body alone,
 * never a log line (ADR 0024).
 */

/** An entry the caller asked for that doesn't exist: an unknown id and one that isn't a canonical UUID, alike. */
export function testRegexNotFound(): AppError {
  return new AppError("test_regex_not_found" satisfies TestRegexErrorCode, "Test regex not found", 404);
}

/**
 * A create, or a change of name, to a name another entry has
 * (uq_test_regex_name): decision 8's words. Found by a read before the
 * check (a create), and by the database's unique index, so two writes
 * racing for one name end in exactly one of these. Nothing is written.
 */
export function testRegexNameTaken(): AppError {
  return new AppError("test_regex_name_taken" satisfies TestRegexErrorCode, TEST_REGEX_NAME_TAKEN_MESSAGE, 409);
}

/** The field a problem names: the evaluator checks the regex as a rule's `pattern`, which the entry calls `regex`. */
function libraryField(field: string): string {
  return field === "pattern" ? "regex" : field;
}

/**
 * The evaluator's RE2 refused the regex (decision 8): its words as it words
 * them ("Invalid regex: …"), the first problem's as the message, each
 * problem with its field (`regex`) in `details`, every message cut to
 * VALIDATION_RULE_PROBLEM_MAXIMUM_LENGTH code points, as a rule's.
 */
export function testRegexInvalid(problems: readonly ValidationRuleProblem[]): AppError {
  const cut = problems.map(({ field, message }) => ({
    field: libraryField(field),
    message: firstCodePoints(message, VALIDATION_RULE_PROBLEM_MAXIMUM_LENGTH),
  }));
  return new AppError("test_regex_invalid" satisfies TestRegexErrorCode, cut[0]?.message ?? "The regex isn't valid.", 400, {
    problems: cut,
  });
}
