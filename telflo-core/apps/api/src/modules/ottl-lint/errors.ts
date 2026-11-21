import { OTTL_LINT_UNAVAILABLE_MESSAGE, type PublicApiErrorCode } from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The OTTL lint's own refusals. Their words are fixed: never the YAML, an
 * expression, the parser's message or the evaluator's. A YAML that doesn't
 * parse is the public surface's shared `configurationInvalid`
 * (public-api/shared-errors.ts).
 */

/** The OTTL evaluator couldn't lint, whatever the reason (down, busy, refusing the secret, a malformed answer): 503. */
export function ottlLintUnavailable(): AppError {
  return new AppError("ottl_lint_unavailable" satisfies PublicApiErrorCode, OTTL_LINT_UNAVAILABLE_MESSAGE, 503);
}

/** A configuration holding more OTTL expressions than one lint checks: 400, as a request of more than 200 expressions. */
export function tooManyExpressions(): AppError {
  return new AppError("invalid_request", "The configuration holds more than 200 OTTL expressions.", 400);
}
