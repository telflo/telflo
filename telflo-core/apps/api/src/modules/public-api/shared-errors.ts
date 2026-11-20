import { CONFIGURATION_INVALID_MESSAGE, type ConfigurationErrorCode, type ConfigurationValidationError } from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * Refusals more than one area of the public surface answers: a text that
 * didn't validate, and a retired collector version. The codes are the
 * platform's existing ones; this file only names the helpers once, so every
 * area answers them alike.
 */

/** A retired pin (400 `collector_version_retired`): the test runs' helper and words. */
export { collectorVersionRetired } from "../test-runs/errors.js";

/**
 * A text that didn't validate (422 `configuration_invalid`), its fixed
 * words, with the collector's messages and component paths, copied field by
 * field, in `details.errors`. Those go only into the reply's body, which no
 * log line or audit row holds (the error handler logs no 4xx) and no cache
 * keeps (`no-store`).
 */
export function configurationInvalid(errors: readonly ConfigurationValidationError[]): AppError {
  return new AppError(
    "configuration_invalid" satisfies ConfigurationErrorCode,
    CONFIGURATION_INVALID_MESSAGE,
    422,
    { errors: errors.map(({ message, componentPath }) => ({ message, componentPath })) },
    { "cache-control": "no-store" },
  );
}
