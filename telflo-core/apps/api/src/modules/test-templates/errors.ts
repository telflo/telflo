import type { TestingErrorCode } from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The test templates' own refusals (D14b detail 19). No message names a
 * template, its file or its content.
 */

/**
 * A template the caller can't use: unknown, deleted (soft), or an id that
 * isn't a canonical UUID, all alike. Also a template whose bytes are gone.
 */
export function testTemplateNotFound(): AppError {
  return new AppError("test_template_not_found" satisfies TestingErrorCode, "Test template not found", 404);
}
