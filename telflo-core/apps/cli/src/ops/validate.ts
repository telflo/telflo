/*
 * Validation's calls and the collector's errors: `POST /validate` with a login
 * (route 15, the organization's variables filled in), or the anonymous route
 * without one. Nothing here prints. The text and the collector's errors (which
 * can quote it) are configuration text: they go to the command's own output
 * only, never into an error's message.
 */

import type { PublicValidateRequest, PublicValidateResponse } from "@telflo/contracts";
import type { ApiClient } from "../api.js";
import type { ApiError } from "../api-error.js";
import { endingOf, ExitError, terminalText } from "../output.js";

/** Route 15's path, and the anonymous route's (both below the prefix). */
export const VALIDATE_PATH = "/validate";
export const ANONYMOUS_VALIDATE_PATH = "/validate/anonymous";

/**
 * A 400 naming a collector the catalog doesn't offer (its version or its
 * distribution): a usage error, exit 2, its code and status kept, for
 * `validate` and `test` alike (a deliberate mapping).
 */
export const COLLECTOR_REFUSED_CODES: ReadonlySet<string> = new Set([
  "collector_distribution_unknown",
  "collector_version_unknown",
  "collector_version_retired",
]);

/** One of the collector's errors, as a reply or a 422's `details.errors` carries it. */
export interface ValidationErrorLine {
  message: string;
  componentPath: string | null;
}

/**
 * A text checked by the collector validator: route 15 with a login, the
 * anonymous route (no token, no organization) with `anonymous`.
 */
export async function validateConfiguration(
  client: ApiClient,
  body: PublicValidateRequest,
  options: { anonymous?: boolean } = {},
): Promise<PublicValidateResponse> {
  if (options.anonymous === true) {
    return client.request<PublicValidateResponse>("POST", ANONYMOUS_VALIDATE_PATH, { body, organization: false });
  }
  return client.request<PublicValidateResponse>("POST", VALIDATE_PATH, { body });
}

/** A 422 `configuration_invalid`'s `details.errors`, read defensively: anything not an error of the collector's is left out. */
export function validationErrorsOf(details: unknown): ValidationErrorLine[] {
  const errors = (details as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((error: unknown) => {
    const { message, componentPath } = (error ?? {}) as { message?: unknown; componentPath?: unknown };
    if (typeof message !== "string") return [];
    return [{ message, componentPath: typeof componentPath === "string" ? componentPath : null }];
  });
}

/**
 * An API refusal (or a CLI ending) reworded: only its message changes,
 * `words` wrapping the ending's own; the exit code, the code and the status
 * are `endingOf`'s, so a 401 still exits 3 with "Run telflo login." and a
 * read-only token's 403 still says so. The deliberate mappings (a 400 about
 * the request to exit 2, an invalid configuration's 422 to exit 4) don't use
 * it.
 */
export function rewordedError(error: ApiError | ExitError, words: (message: string) => string): ExitError {
  const ending = endingOf(error);
  return new ExitError(words(ending.message), ending.exitCode, ending.code, ending.status ?? undefined);
}

/** The errors as the terminal shows them: one indented line each, the component's path after it, control characters out. */
export function renderValidationErrors(errors: readonly ValidationErrorLine[]): string[] {
  return errors.map(
    (error) => `  - ${terminalText(error.message)}${error.componentPath === null ? "" : ` (${terminalText(error.componentPath)})`}`,
  );
}
