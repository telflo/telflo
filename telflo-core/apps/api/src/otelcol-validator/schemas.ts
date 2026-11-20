import { CONFIGURATION_VALIDATION_REQUIREMENT_CATEGORIES } from "@telflo/contracts";
import { z } from "zod";

// The collector validator's answers, as zod schemas, one for each schema in
// services/otelcol-validator/openapi.yaml the platform reads. Unknown fields
// are stripped rather than refused, unlike the file's
// `additionalProperties: false`, as the opamp-server's are: a field the
// validator adds later must not break a platform that hasn't learned it. The
// fake (testing/fake-otelcol-validator.ts) checks the validator's side of the
// contract strictly, against the file itself.
//
// An answer these refuse is a malformed answer, which the client reports as
// unavailable, never as the text's own result.

/** openapi.yaml's componentPath: `::`-separated, keeping the whole id; null when it names nothing. */
const componentPath = z.string().nullable();

/** openapi.yaml's ValidationError. */
export const validationErrorSchema = z.object({
  message: z.string().min(1),
  componentPath,
});

/** openapi.yaml's Requirement: one of the nine categories. */
export const requirementSchema = z.object({
  category: z.enum(CONFIGURATION_VALIDATION_REQUIREMENT_CATEGORIES),
  title: z.string().min(1),
  description: z.string().min(1),
  componentPath,
});

/**
 * openapi.yaml's ValidateResponse: `valid` is false exactly when `errors`
 * isn't empty (the file's if/then/else).
 */
export const validateResponseSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(validationErrorSchema),
    requirements: z.array(requirementSchema),
    distribution: z.string(),
    version: z.string(),
  })
  .refine((answer) => answer.valid === (answer.errors.length === 0), {
    message: "valid must be false exactly when errors isn't empty",
    path: ["valid"],
  });

/** openapi.yaml's error codes. */
export const OTELCOL_VALIDATOR_ERROR_CODES = [
  "unauthorized",
  "invalid_request",
  "not_found",
  "version_retired",
  "version_unavailable",
  "validator_busy",
  "payload_too_large",
  "internal_error",
] as const;

/** openapi.yaml's Error: the envelope every error answers. */
export const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.enum(OTELCOL_VALIDATOR_ERROR_CODES), message: z.string() }),
});

export type ValidatorValidationError = z.infer<typeof validationErrorSchema>;
export type ValidatorRequirement = z.infer<typeof requirementSchema>;
export type ValidateResponse = z.infer<typeof validateResponseSchema>;
