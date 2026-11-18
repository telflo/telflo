import { z } from "zod";
import { TEST_RUN_SIGNALS, TestRunPipelineSchema } from "../test-run-pipelines.js";
import {
  checkRuleContent,
  CreateValidationRuleRequestSchema,
  isSignalOfPipeline,
  ValidationPipelineFieldsSchema,
  ValidationRuleFieldsSchema,
} from "../validation-rules.js";

/*
 * The public surface's request and response shapes for a version's
 * validation pipelines (routes 13–14) (D25 decisions 17, 18, 19 and 32;
 * Preflight ruling 8): strict Zod schemas, camelCase, in the platform's
 * pipeline and rule shapes (D15a's), which the Validation tab reads, plus
 * what the public API adds: each rule's `isApiOwned`, the pipeline's
 * version number, and the PUT's counts.
 *
 * A rule is the platform's (`kind`, `target`, `pattern` or `ottl`, `name`,
 * `description`). A pipeline has no name of its own.
 */

/** At most this many rules in one PUT. */
export const PUBLIC_VALIDATION_PIPELINE_RULES_MAXIMUM = 20;

/**
 * The PUT's rule the evaluator refused (400 `validation_rule_invalid`):
 * fixed words (decision 20); `details` holds `ruleIndex` (the rule's place
 * in the body, from 0) and the evaluator's `problems`.
 */
export const PUBLIC_VALIDATION_RULE_INVALID_MESSAGE = "A rule is not valid: see the problems in details.";

/**
 * The PUT's pipeline that isn't a key of the version's `service.pipelines`
 * (422 `configuration_invalid`, its one error at `service.pipelines`).
 * Fixed words: never the name, nor the names the text has.
 */
export const PUBLIC_PIPELINE_NOT_IN_CONFIGURATION_MESSAGE = "The version's configuration has no pipeline of this name.";

/**
 * The PUT's body `signal` that isn't its pipeline's first part (400
 * `invalid_request`, its one issue at `signal`).
 */
export const PUBLIC_PIPELINE_SIGNAL_MISMATCH_MESSAGE = "The signal must be the pipeline name's first part.";

/**
 * The pipeline's name in route 14's path, after Fastify's one decoding
 * (`traces/otlp`, raw or as `traces%2Fotlp`): the platform's pipeline name,
 * 1 to 200 characters, nothing Postgres can't store (400 otherwise).
 */
export const PublicValidationPipelineNameSchema = TestRunPipelineSchema;

/** A rule as the public surface answers it: the platform's, and whether the public API wrote it. */
export const PublicValidationRuleSchema = ValidationRuleFieldsSchema.extend({ isApiOwned: z.boolean() })
  .strict()
  .superRefine(checkRuleContent);

export type PublicValidationRule = z.infer<typeof PublicValidationRuleSchema>;

/** A validation pipeline as the public surface answers it: the platform's, its version's number, and its rules in position order. */
export const PublicValidationPipelineSchema = ValidationPipelineFieldsSchema.extend({
  versionNumber: z.number().int().min(1),
  rules: z.array(PublicValidationRuleSchema),
})
  .strict()
  .refine(isSignalOfPipeline, { message: "The pipeline's signal must be its name's first part.", path: ["signal"] });

export type PublicValidationPipeline = z.infer<typeof PublicValidationPipelineSchema>;

/** `GET …/validation-pipelines`: every pipeline the caller can see on the version, oldest first; not paginated (decision 19). */
export const PublicValidationPipelinesSchema = z
  .object({ items: z.array(PublicValidationPipelineSchema), nextCursor: z.null() })
  .strict();

export type PublicValidationPipelines = z.infer<typeof PublicValidationPipelinesSchema>;

/**
 * `PUT …/validation-pipelines/{pipeline}`: the rules the public API owns on
 * that pipeline, 1 to 20 in the platform's rule shape (each as the
 * Validation tab's create takes it), and the pipeline's signal, which must
 * be its name's first part. Strict.
 */
export const PublicReplaceValidationRulesRequestSchema = z
  .object({
    signal: z.enum(TEST_RUN_SIGNALS),
    rules: z.array(CreateValidationRuleRequestSchema).min(1).max(PUBLIC_VALIDATION_PIPELINE_RULES_MAXIMUM),
  })
  .strict();

export type PublicReplaceValidationRulesRequest = z.input<typeof PublicReplaceValidationRulesRequestSchema>;

/** The PUT's answer: the pipeline as it now is, whether this call created it, and the counts. */
export const PublicReplacedValidationRulesSchema = ValidationPipelineFieldsSchema.extend({
  versionNumber: z.number().int().min(1),
  rules: z.array(PublicValidationRuleSchema),
  created: z.boolean(),
  rulesReplaced: z.number().int().min(0),
  rulesKept: z.number().int().min(0),
})
  .strict()
  .refine(isSignalOfPipeline, { message: "The pipeline's signal must be its name's first part.", path: ["signal"] });

export type PublicReplacedValidationRules = z.infer<typeof PublicReplacedValidationRulesSchema>;
