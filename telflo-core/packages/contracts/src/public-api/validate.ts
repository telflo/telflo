import { z } from "zod";
import { CollectorDistributionIdSchema, CollectorVersionNumberSchema } from "../collector-distributions.js";
import { ConfigurationValidationErrorSchema, ValidateConfigurationVersionRequestSchema } from "../configurations.js";

/*
 * The public surface's request and response shapes for validate (route 15):
 * strict Zod schemas, camelCase, reusing the platform's contracts where
 * they already hold a field. Exported from the package's index with
 * `export *`.
 */

/**
 * `POST /api/public/v1/validate`: a collector configuration's text, checked
 * by the collector validator, nothing stored. The text is a version's
 * validation's (1 to 262,144 characters, no control character but tab, line
 * feed and carriage return, no lone surrogate). `distribution` and
 * `collectorVersion` default to the catalog's: the default distribution,
 * and the distribution's default version. A distribution the catalog
 * doesn't have is 400 `collector_distribution_unknown`, a version it
 * doesn't have 400 `collector_version_unknown`, and a retired one 400
 * `collector_version_retired`.
 */
export const PublicValidateRequestSchema = z
  .object({
    yaml: ValidateConfigurationVersionRequestSchema.shape.yaml,
    distribution: CollectorDistributionIdSchema.optional(),
    collectorVersion: CollectorVersionNumberSchema.optional(),
  })
  .strict();

export type PublicValidateRequest = z.infer<typeof PublicValidateRequestSchema>;

/**
 * The validator's verdict: `valid`, the collector version checked against,
 * and the collector's errors. A validator that couldn't check the text is never
 * `valid: false`: it is 503 `validation_unavailable`.
 */
export const PublicValidateResponseSchema = z
  .object({
    valid: z.boolean(),
    collectorVersion: z.string(),
    errors: z.array(ConfigurationValidationErrorSchema),
  })
  .strict();

export type PublicValidateResponse = z.infer<typeof PublicValidateResponseSchema>;
