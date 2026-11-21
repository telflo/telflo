import {
  TEST_DEFINITION_LIMIT_MESSAGE,
  TEST_SUITE_LIMIT_MESSAGE,
  type TestingErrorCode,
} from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The test suites' and definitions' own refusals. The organization's
 * (`organization_not_found`), the configurations' (`configuration_not_found`,
 * `configuration_version_not_found`) and the test files' and templates'
 * (`test_file_not_found`, `test_template_not_found`) are those modules', so
 * every endpoint answers them alike. No message names a
 * suite, a definition, a file or a template.
 */

/**
 * A suite the caller can't see: unknown, another version's, another
 * member's draft's, another organization's, or an id that isn't a
 * canonical UUID, all alike.
 */
export function testSuiteNotFound(): AppError {
  return new AppError("test_suite_not_found" satisfies TestingErrorCode, "Test suite not found", 404);
}

/**
 * A definition the caller can't see:
 * unknown, another suite's, or an id that isn't a canonical UUID, all
 * alike. Also a definition whose input's bytes are gone.
 */
export function testDefinitionNotFound(): AppError {
  return new AppError("test_definition_not_found" satisfies TestingErrorCode, "Test configuration not found", 404);
}

/** A version's 101st suite, in fixed words. */
export function testSuiteLimitReached(): AppError {
  return new AppError("test_suite_limit_reached" satisfies TestingErrorCode, TEST_SUITE_LIMIT_MESSAGE, 409);
}

/** A suite's 101st definition, in fixed words. */
export function testDefinitionLimitReached(): AppError {
  return new AppError("test_definition_limit_reached" satisfies TestingErrorCode, TEST_DEFINITION_LIMIT_MESSAGE, 409);
}
