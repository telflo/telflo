import { OTTL_CONTEXTS, VALIDATION_RULE_TARGETS } from "@telflo/contracts";
import { z } from "zod";

// The OTTL evaluator's answers, as zod schemas, one for each schema in
// services/ottl-evaluator/openapi.yaml the platform reads. Unknown fields are
// stripped rather than refused, unlike the file's
// `additionalProperties: false`, as the validator's and the tester's are
// (otelcol-validator/schemas.ts, otelcol-testing/schemas.ts): a field the
// evaluator adds later must not break a platform that hasn't learned it. The
// fake (testing/fake-ottl-evaluator.ts) checks the evaluator's side of the
// contract strictly, against the file itself.
//
// A result also keeps the file's prose: an error means `passed` is false and
// `detail` null; a rule that passed has no detail. So whatever the client
// returns passes the contracts' strict ValidationRuleResultSchema, which a
// run's detail serialises with. An answer these refuse is a malformed
// answer, which the client reports as unavailable, never as the rules' own
// results. The lint's answer is LintAnswer.

/** How many code points `text` holds, as JSON Schema's `maxLength` counts (zod's `max` counts UTF-16 units). */
function codePointLength(text: string): number {
  let surrogatePairs = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        surrogatePairs += 1;
        index += 1;
      }
    }
  }
  return text.length - surrogatePairs;
}

/** A string of at most `maximum` code points. */
const boundedText = (maximum: number) =>
  z.string().refine((text) => codePointLength(text) <= maximum, { message: `at most ${maximum} characters` });

const nonNegativeInteger = z.number().int().min(0);

/** openapi.yaml's RuleId: the platform sends rule ids (UUIDs). */
const ruleIdSchema = z.string().min(1).max(128);

/** openapi.yaml's Message: a rule's error or advisory. */
const messageSchema = z.string().min(1).pipe(boundedText(4_096));

/** openapi.yaml's Match's record: OutputRecord or LogLine. */
const matchRecordSchema = z.union([
  z.object({ index: nonNegativeInteger.nullable(), path: boundedText(200) }),
  z.object({ line: z.number().int().min(1) }),
]);

/** openapi.yaml's Match. */
const matchSchema = z.object({
  text: boundedText(200),
  textTruncated: z.boolean(),
  before: boundedText(40),
  after: boundedText(40),
  record: matchRecordSchema,
});

/** openapi.yaml's Miss. */
const missSchema = z.object({ index: nonNegativeInteger, reason: z.string(), snippet: boundedText(200) });

/** openapi.yaml's NoMatch, UnexpectedMatch, RecordMismatch and DistinctMismatch, by `kind`. */
export const detailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_match"), source: z.enum(VALIDATION_RULE_TARGETS), searchedCharacters: nonNegativeInteger }),
  z.object({
    kind: z.literal("unexpected_match"),
    source: z.enum(VALIDATION_RULE_TARGETS),
    totalMatchCount: z.number().int().min(1).max(100_000),
    moreMatches: z.boolean(),
    matches: z.array(matchSchema).min(1).max(5),
  }),
  z.object({
    kind: z.literal("record_mismatch"),
    context: z.enum(OTTL_CONTEXTS),
    totalCount: nonNegativeInteger,
    matchedCount: nonNegativeInteger,
    missCount: nonNegativeInteger,
    misses: z.array(missSchema).max(5),
  }),
  z.object({
    kind: z.literal("distinct_mismatch"),
    totalCount: nonNegativeInteger,
    matchedCount: nonNegativeInteger,
    distinctCount: nonNegativeInteger,
    samples: z.array(boundedText(120)).max(5),
  }),
]);

/** openapi.yaml's Result, with its prose: an error fails the rule with no detail; a pass has no detail. */
export const resultSchema = z
  .object({
    id: ruleIdSchema,
    passed: z.boolean(),
    error: messageSchema.nullable(),
    advisory: messageSchema.nullable(),
    detail: detailSchema.nullable(),
  })
  .refine((result) => result.error === null || (!result.passed && result.detail === null), {
    message: "an error means passed is false and detail is null",
    path: ["error"],
  })
  .refine((result) => !result.passed || result.detail === null, {
    message: "a rule that passed has no detail",
    path: ["detail"],
  });

/** openapi.yaml's EvaluateAnswer. Which result is whose is the client's check (by id). */
export const evaluateAnswerSchema = z.object({
  ottlVersion: z.string().min(1),
  results: z.array(resultSchema).max(200),
});

/** openapi.yaml's Problem's fields. */
export const OTTL_EVALUATOR_PROBLEM_FIELDS = [
  "kind",
  "pattern",
  "ottl",
  "ottl.context",
  "ottl.quantifier",
  "ottl.condition",
  "ottl.expression",
  "ottl.count",
  "ottl.count.value2",
] as const;

/** openapi.yaml's Problem: the field it is about, and the evaluator's words for it. */
export const problemSchema = z.object({ field: z.enum(OTTL_EVALUATOR_PROBLEM_FIELDS), message: messageSchema });

/** openapi.yaml's ValidateAnswer: `problems` only when the rule isn't valid, then at least one. */
export const validateAnswerSchema = z
  .object({
    valid: z.boolean(),
    problems: z.array(problemSchema).min(1).optional(),
    ottlVersion: z.string().min(1),
  })
  .refine((answer) => answer.valid === (answer.problems === undefined), {
    message: "problems must be there exactly when the rule isn't valid",
    path: ["problems"],
  });

/** openapi.yaml's LintItem's kinds. */
export const OTTL_LINT_KINDS = ["condition", "statement", "valueExpression"] as const;

/** openapi.yaml's LintItem: `error` there exactly when the text isn't valid. */
export const lintItemSchema = z
  .object({
    kind: z.enum(OTTL_LINT_KINDS),
    index: z.number().int().min(0).max(199),
    valid: z.boolean(),
    error: messageSchema.optional(),
  })
  .refine((item) => item.valid === (item.error === undefined), {
    message: "error must be there exactly when the text isn't valid",
    path: ["error"],
  });

/** openapi.yaml's LintAnswer. Which item is whose is the client's check (by kind and index, in order). */
export const lintAnswerSchema = z.object({
  ottlVersion: z.string().min(1),
  items: z.array(lintItemSchema).min(1).max(200),
});

/** openapi.yaml's Health. */
export const healthSchema = z.object({ status: z.literal("ok"), ottlVersion: z.string().min(1) });

/** openapi.yaml's error codes. */
export const OTTL_EVALUATOR_ERROR_CODES = [
  "unauthorized",
  "not_found",
  "method_not_allowed",
  "payload_too_large",
  "invalid_request",
  "evaluator_busy",
  "internal_error",
] as const;
export type OttlEvaluatorErrorCode = (typeof OTTL_EVALUATOR_ERROR_CODES)[number];

/** openapi.yaml's ErrorEnvelope. */
export const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.enum(OTTL_EVALUATOR_ERROR_CODES), message: z.string() }),
});

export type OttlEvaluatorProblem = z.infer<typeof problemSchema>;
export type OttlEvaluatorResult = z.infer<typeof resultSchema>;
export type OttlLintKind = (typeof OTTL_LINT_KINDS)[number];
