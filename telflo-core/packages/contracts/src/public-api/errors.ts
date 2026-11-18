/*
 * The public surface's own error codes (D25 decision 20, Preflight ruling
 * 7), named once so a misspelled code is a type error. Every other refusal
 * of `/api/public/v1/` reuses the platform's existing codes: the token
 * check's `invalid_api_token`, `organization_access_denied`, the areas'
 * own (`configuration_invalid` is the configurations', and
 * `test_run_output_not_found` the test runs'), and the generic ones.
 * Messages are fixed words: never a name, a YAML, a rule, a sample or a
 * downstream service's text.
 */

export const PUBLIC_API_ERROR_CODES = ["insufficient_access", "organization_required", "ottl_lint_unavailable"] as const;

export type PublicApiErrorCode = (typeof PUBLIC_API_ERROR_CODES)[number];

/** A read token on a `write` route (403; decision 25). */
export const INSUFFICIENT_ACCESS_MESSAGE = "This token can't make changes.";
/** A personal token without a well-formed `X-Telflo-Org` where one is needed (400; decision 24). */
export const ORGANIZATION_REQUIRED_MESSAGE = "Send the organization's id in X-Telflo-Org.";
/** The OTTL evaluator couldn't lint, whatever the reason (503; decision 33). Never the reason itself. */
export const OTTL_LINT_UNAVAILABLE_MESSAGE = "OTTL lint is unavailable right now. Try again shortly.";

/** Each code's words, as the API answers them. */
export const PUBLIC_API_ERROR_MESSAGES: Readonly<Record<PublicApiErrorCode, string>> = {
  insufficient_access: INSUFFICIENT_ACCESS_MESSAGE,
  organization_required: ORGANIZATION_REQUIRED_MESSAGE,
  ottl_lint_unavailable: OTTL_LINT_UNAVAILABLE_MESSAGE,
};
