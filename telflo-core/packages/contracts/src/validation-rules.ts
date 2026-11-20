import { z } from "zod";
import { hasUnstorableCharacter, utf8ByteLength } from "./configurations.js";
import {
  codePointLength,
  TEST_RUN_PIPELINE_MAXIMUM_LENGTH,
  TEST_RUN_SIGNALS,
  TestRunPipelineSchema,
  type TestRunSignal,
} from "./test-run-pipelines.js";

/*
 * Validation pipelines and their rules, under
 * /api/v1/organizations/:organizationId/configurations/:configurationId/
 * versions/:versionId:
 *
 * - `GET /validation-pipelines` (the version's, oldest first) and
 *   `POST /validation-pipelines` (`{pipeline}`); `DELETE
 *   /validation-pipelines/:validationPipelineId`;
 * - `GET …/:validationPipelineId/rules` (in position order) and
 *   `POST …/:validationPipelineId/rules`; `PATCH` and `DELETE
 *   …/rules/:ruleId`. A rule's `POST` and `PATCH` have the OTTL evaluator
 *   check its OTTL or regex first.
 *
 * A validation pipeline is one YAML pipeline's (`logs/default`), one per
 * version and pipeline; its signal is its name's first part. It is created
 * and deleted, never changed. There is no cap on how many a version has, and
 * at most VALIDATION_RULES_PER_PIPELINE_MAXIMUM rules each.
 *
 * A rule is one of five kinds: text and regex rules hold a `pattern` and
 * search the run's output or the collector's log (`target`); an OTTL rule
 * holds its `ottl` and checks the output only. The bounds are migration
 * 030's checks (ck_validation_rules_*) and the evaluator's contract
 * (services/ottl-evaluator/openapi.yaml): a pattern, condition or expression
 * is at most 8,192 BYTES, as Postgres's octet_length and the evaluator count
 * them, never characters.
 *
 * A rule's name, description, pattern and OTTL, and a result's snippets and
 * samples, are configuration text: they travel only in these JSON
 * bodies, never in a URL, a log line or an audit row.
 */

/** How many rules a validation pipeline may have: the evaluator's per-request maximum. */
export const VALIDATION_RULES_PER_PIPELINE_MAXIMUM = 200;

/** A pattern's, a condition's or an expression's most bytes of UTF-8. */
export const VALIDATION_RULE_TEXT_MAXIMUM_BYTES = 8_192;

/** A rule's name, after trimming: at most 200 characters; `''` is none (ck_validation_rules_name_length). */
export const VALIDATION_RULE_NAME_MAXIMUM_LENGTH = 200;

/** A rule's description, after trimming: at most 2,000 characters; `''` is none. */
export const VALIDATION_RULE_DESCRIPTION_MAXIMUM_LENGTH = 2_000;

/** A count's largest value: Postgres's `integer`, as the evaluator's contract bounds it. */
export const VALIDATION_RULE_COUNT_MAXIMUM = 2_147_483_647;

/** How many checked saves a person may make a minute in each organization. */
export const VALIDATION_RULE_CHECKS_PER_MINUTE_PER_USER = 30;

/** The five kinds of rule. */
export const VALIDATION_RULE_KINDS = ["contains_text", "not_contains_text", "contains_regex", "not_contains_regex", "ottl"] as const;

export type ValidationRuleKind = (typeof VALIDATION_RULE_KINDS)[number];

/** The kinds that hold a `pattern`: text and regex rules. */
export const VALIDATION_RULE_PATTERN_KINDS = ["contains_text", "not_contains_text", "contains_regex", "not_contains_regex"] as const;

/** What a rule searches: the run's output, or the collector's log. An OTTL rule checks the output only. */
export const VALIDATION_RULE_TARGETS = ["output", "stderr"] as const;

export type ValidationRuleTarget = (typeof VALIDATION_RULE_TARGETS)[number];

/** The seven OTTL contexts (migration 030's ck_validation_rules_ottl_context). */
export const OTTL_CONTEXTS = ["log", "span", "spanevent", "metric", "datapoint", "resource", "scope"] as const;

export type OttlContext = (typeof OTTL_CONTEXTS)[number];

/**
 * The contexts a pipeline's signal allows, as the evaluator's own table has
 * them (pkg/ottlassert's signalContexts): the API checks a rule's context
 * against its pipeline's signal (a wrong pair is 400 `invalid_request`), and
 * the editor offers only these.
 */
export const OTTL_CONTEXTS_BY_SIGNAL: Readonly<Record<TestRunSignal, readonly OttlContext[]>> = {
  logs: ["log", "resource", "scope"],
  traces: ["span", "spanevent", "resource", "scope"],
  metrics: ["metric", "datapoint", "resource", "scope"],
};

/** Whether a rule of a `signal` pipeline may use `context`. */
export function isOttlContextOfSignal(context: string, signal: TestRunSignal): boolean {
  return (OTTL_CONTEXTS_BY_SIGNAL[signal] as readonly string[]).includes(context);
}

/** How an OTTL rule folds its condition over the records. */
export const OTTL_QUANTIFIERS = ["all", "any", "none", "count", "distinct"] as const;

export type OttlQuantifier = (typeof OTTL_QUANTIFIERS)[number];

/** A count's comparison; `between` takes a second value, at least the first. */
export const OTTL_COUNT_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "between"] as const;

export type OttlCountOperator = (typeof OTTL_COUNT_OPERATORS)[number];

/** A validation pipeline's signal: its name's first part, when that is a signal. */
export function signalOfPipeline(pipeline: string): TestRunSignal | undefined {
  const first = pipeline.split("/")[0];
  return (TEST_RUN_SIGNALS as readonly string[]).includes(first ?? "") ? (first as TestRunSignal) : undefined;
}

/**
 * Whitespace as the evaluator reads it: Go's `unicode.IsSpace`, the no-break
 * space included. A text, regex or OTTL text of nothing else is blank.
 */
const ONLY_WHITESPACE = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;

/** Whether `text` holds nothing but whitespace (Go's unicode.IsSpace). */
export function isBlankRuleText(text: string): boolean {
  return ONLY_WHITESPACE.test(text);
}

/** ONLY_WHITESPACE's characters, each one UTF-16 code unit: Go's unicode.IsSpace. */
const WHITESPACE_UNITS: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/**
 * `text` without the whitespace at either end, whitespace being exactly
 * isBlankRuleText's (Go's `unicode.IsSpace`): U+0085 goes, which
 * JavaScript's `trim` keeps, and U+FEFF stays, which it strips. A text
 * isBlankRuleText calls blank trims to `''`, and no other does.
 */
export function trimRuleText(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && WHITESPACE_UNITS.has(text.charCodeAt(start))) start += 1;
  while (end > start && WHITESPACE_UNITS.has(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** A pattern, condition or expression past VALIDATION_RULE_TEXT_MAXIMUM_BYTES: the API's words (`name` "pattern", "condition", "expression"). */
export function ruleTextTooLongMessage(name: string): string {
  return `The ${name} is longer than 8,192 bytes.`;
}

/**
 * A pattern, a condition or an expression, as it is sent and stored (never
 * trimmed: a regex's spaces are part of it): not blank, at most 8,192 bytes
 * of UTF-8 (a code point outside the BMP is 4), nothing Postgres can't store
 * exactly (U+0000, a lone surrogate). `name` is the text's in the refusals'
 * words ("The pattern is empty."). Also a regex library entry's regex
 * (test-regexes.ts), so every entry is a pattern a regex rule takes.
 */
export function ruleTextSchema(name: string) {
  return z
    .string()
    .refine((text) => !hasUnstorableCharacter(text), `The ${name} can't contain U+0000 or a lone surrogate.`)
    .refine((text) => utf8ByteLength(text) <= VALIDATION_RULE_TEXT_MAXIMUM_BYTES, ruleTextTooLongMessage(name))
    .refine((text) => !isBlankRuleText(text), `The ${name} is empty.`);
}

/** A string of at most `maximum` code points (codePointLength), as Postgres's char_length counts. */
const atMostCodePoints = (maximum: number) =>
  z.string().refine((text) => codePointLength(text) <= maximum, {
    message: `String must contain at most ${maximum} character(s)`,
  });

/** A count's value: an integer from 0 to 2,147,483,647. */
const CountValueSchema = z.number().int().min(0).max(VALIDATION_RULE_COUNT_MAXIMUM);

/** A count or distinct rule's comparison: `value2` with `between` only, at least `value`. */
export const ValidationRuleCountSchema = z
  .object({
    operator: z.enum(OTTL_COUNT_OPERATORS),
    value: CountValueSchema,
    value2: CountValueSchema.optional(),
  })
  .strict()
  .superRefine((count, context) => {
    if (count.operator === "between") {
      if (count.value2 === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Between needs a second value.", path: ["value2"] });
      } else if (count.value2 < count.value) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Between's second value can't be less than its first.",
          path: ["value2"],
        });
      }
    } else if (count.value2 !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Only between has a second value.", path: ["value2"] });
    }
  });

export type ValidationRuleCount = z.infer<typeof ValidationRuleCountSchema>;

/**
 * An OTTL rule's OTTL (`{context, condition, quantifier, count?,
 * expression?}`, migration 030's ottl_* columns): `all`, `any` and
 * `none` take a condition only; `count` a condition and a count; `distinct`
 * an expression and a count, its condition an optional filter. A field a
 * quantifier doesn't take is absent, never null or `''`. Which contexts its
 * pipeline's signal allows is OTTL_CONTEXTS_BY_SIGNAL's check, made by the
 * API (the signal isn't in the request).
 */
export const ValidationRuleOttlSchema = z
  .object({
    context: z.enum(OTTL_CONTEXTS),
    quantifier: z.enum(OTTL_QUANTIFIERS),
    condition: ruleTextSchema("condition").optional(),
    expression: ruleTextSchema("expression").optional(),
    count: ValidationRuleCountSchema.optional(),
  })
  .strict()
  .superRefine((ottl, context) => {
    const issue = (message: string, path: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    const isDistinct = ottl.quantifier === "distinct";
    if (!isDistinct && ottl.condition === undefined) issue("The condition is empty.", "condition");
    if (isDistinct && ottl.expression === undefined) issue("A distinct rule needs an expression.", "expression");
    if (!isDistinct && ottl.expression !== undefined) issue("Only a distinct rule has an expression.", "expression");
    const takesCount = ottl.quantifier === "count" || isDistinct;
    if (takesCount && ottl.count === undefined) issue("A count or distinct rule needs a count.", "count");
    if (!takesCount && ottl.count !== undefined) issue("Only a count or distinct rule has a count.", "count");
  });

export type ValidationRuleOttl = z.infer<typeof ValidationRuleOttlSchema>;

/** A rule's name: trimmed, at most 200 characters, `''` for none, nothing Postgres can't store. */
export const ValidationRuleNameSchema = z
  .string()
  .trim()
  .pipe(atMostCodePoints(VALIDATION_RULE_NAME_MAXIMUM_LENGTH))
  .refine((name) => !hasUnstorableCharacter(name), "The name can't contain U+0000 or a lone surrogate.");

/** A rule's description: trimmed, at most 2,000 characters, `''` for none. */
export const ValidationRuleDescriptionSchema = z
  .string()
  .trim()
  .pipe(atMostCodePoints(VALIDATION_RULE_DESCRIPTION_MAXIMUM_LENGTH))
  .refine((text) => !hasUnstorableCharacter(text), "The description can't contain U+0000 or a lone surrogate.");

/** What a rule checks: its kind, target, and its pattern or OTTL. */
interface RuleContent {
  kind?: ValidationRuleKind | undefined;
  target?: ValidationRuleTarget | undefined;
  pattern?: string | null | undefined;
  ottl?: ValidationRuleOttl | null | undefined;
}

/**
 * The kind's fields, as migration 030's checks have them: an OTTL rule
 * targets the output and holds its OTTL and no pattern
 * (ck_validation_rules_ottl_output_only, _pattern_only_text_and_regex,
 * _ottl_only_ottl); a text or regex rule holds its pattern and no OTTL.
 */
export function checkRuleContent(rule: RuleContent, context: z.RefinementCtx): void {
  const issue = (message: string, path: string) =>
    context.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
  const hasPattern = rule.pattern !== undefined && rule.pattern !== null;
  const hasOttl = rule.ottl !== undefined && rule.ottl !== null;
  if (rule.kind === "ottl") {
    if (rule.target !== "output") issue("An OTTL rule checks the output only.", "target");
    if (!hasOttl) issue("An OTTL rule needs its OTTL.", "ottl");
    if (hasPattern) issue("Only a text or regex rule has a pattern.", "pattern");
  } else {
    if (!hasPattern) issue("A text or regex rule needs its pattern.", "pattern");
    if (hasOttl) issue("Only an OTTL rule has OTTL.", "ottl");
  }
}

/**
 * `POST …/:validationPipelineId/rules`: a rule, as the rule editor saves it
 * (its four modes all save one of the five kinds; the builders
 * save canonical OTTL). Strict: an unknown field is 400 `invalid_request`.
 * The name and the description may be left out (`''`). Its OTTL's context
 * must be its pipeline's signal's (400 `invalid_request`), and an OTTL or
 * regex rule must pass the evaluator's check (400 `validation_rule_invalid`,
 * the evaluator's words). A pipeline's 201st is 409
 * `validation_rule_limit_reached`.
 */
export const CreateValidationRuleRequestSchema = z
  .object({
    kind: z.enum(VALIDATION_RULE_KINDS),
    target: z.enum(VALIDATION_RULE_TARGETS),
    pattern: ruleTextSchema("pattern").optional(),
    ottl: ValidationRuleOttlSchema.optional(),
    name: ValidationRuleNameSchema.default(""),
    description: ValidationRuleDescriptionSchema.default(""),
  })
  .strict()
  .superRefine(checkRuleContent);

/** What a client sends: `name` and `description` may be left out. */
export type CreateValidationRuleRequest = z.input<typeof CreateValidationRuleRequestSchema>;

/**
 * `PATCH …/rules/:ruleId`: a new name, description, or what the rule checks
 * (the editor may switch modes, so the kind may change). What it checks
 * travels whole: naming any of `kind`, `target`, `pattern` and `ottl` needs
 * `kind` and `target`, and the kind's own fields, as a create does; a field
 * left out stays as it is. None at all (`{}`) changes nothing and answers
 * the rule as it is, as a suite's PATCH. A change of the name, the
 * description, the target or the OTTL's quantifier or count needs no
 * evaluator; a change of a pattern, context, condition or expression does.
 */
export const UpdateValidationRuleRequestSchema = z
  .object({
    kind: z.enum(VALIDATION_RULE_KINDS).optional(),
    target: z.enum(VALIDATION_RULE_TARGETS).optional(),
    pattern: ruleTextSchema("pattern").optional(),
    ottl: ValidationRuleOttlSchema.optional(),
    name: ValidationRuleNameSchema.optional(),
    description: ValidationRuleDescriptionSchema.optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    const namesContent = [rule.kind, rule.target, rule.pattern, rule.ottl].some((field) => field !== undefined);
    if (!namesContent) return;
    if (rule.kind === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "What a rule checks needs its kind.", path: ["kind"] });
    }
    if (rule.target === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "What a rule checks needs its target.", path: ["target"] });
    }
    if (rule.kind !== undefined) checkRuleContent(rule, context);
  });

export type UpdateValidationRuleRequest = z.infer<typeof UpdateValidationRuleRequestSchema>;

/** A stored pattern, condition or expression, as a response carries it: at most 8,192 bytes. */
const StoredRuleTextSchema = z.string().refine((text) => utf8ByteLength(text) <= VALIDATION_RULE_TEXT_MAXIMUM_BYTES, {
  message: "The text is longer than 8,192 bytes.",
});

/**
 * A rule. `position` orders a pipeline's rules (from 1; gaps after a delete
 * are fine). `pattern` is null for an OTTL rule, `ottl` null for the
 * others. `createdByUserId` is null once that account is hard-deleted. The
 * timestamps are ISO 8601. Its name, description, pattern and OTTL are
 * configuration text. Its fields alone, which the public API's shape
 * extends (public-api/validation-pipelines.ts).
 */
export const ValidationRuleFieldsSchema = z
  .object({
    id: z.string().uuid(),
    validationPipelineId: z.string().uuid(),
    position: z.number().int().min(1),
    kind: z.enum(VALIDATION_RULE_KINDS),
    target: z.enum(VALIDATION_RULE_TARGETS),
    pattern: StoredRuleTextSchema.nullable(),
    ottl: ValidationRuleOttlSchema.nullable(),
    name: atMostCodePoints(VALIDATION_RULE_NAME_MAXIMUM_LENGTH),
    description: atMostCodePoints(VALIDATION_RULE_DESCRIPTION_MAXIMUM_LENGTH),
    createdByUserId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/** A rule as a response carries it: ValidationRuleFieldsSchema, its kind's fields checked. */
export const ValidationRuleSchema = ValidationRuleFieldsSchema.superRefine(checkRuleContent);

export type ValidationRule = z.infer<typeof ValidationRuleSchema>;

/** `GET …/rules`: the pipeline's rules, in position order, at most VALIDATION_RULES_PER_PIPELINE_MAXIMUM. */
export const ValidationRulesResponseSchema = z
  .object({ rules: z.array(ValidationRuleSchema).max(VALIDATION_RULES_PER_PIPELINE_MAXIMUM) })
  .strict();

export type ValidationRulesResponse = z.infer<typeof ValidationRulesResponseSchema>;

/** `POST …/rules` (201) and `PATCH …/rules/:ruleId`: the rule. */
export const ValidationRuleResponseSchema = z.object({ rule: ValidationRuleSchema }).strict();

export type ValidationRuleResponse = z.infer<typeof ValidationRuleResponseSchema>;

/**
 * `POST …/validation-pipelines`: one YAML pipeline's validation pipeline,
 * by its name as the text names it (`logs`, `logs/default`), whose first
 * part is a signal (ck_validation_pipelines_pipeline_signal). Whether the
 * text still has that pipeline isn't checked: the editor's text may be
 * unsaved. A second for the same pipeline and version is 409
 * `validation_pipeline_exists`. Strict.
 */
export const CreateValidationPipelineRequestSchema = z
  .object({
    pipeline: TestRunPipelineSchema.refine((pipeline) => signalOfPipeline(pipeline) !== undefined, {
      message: "The pipeline's name must start with its signal: traces, metrics or logs.",
    }),
  })
  .strict();

export type CreateValidationPipelineRequest = z.infer<typeof CreateValidationPipelineRequestSchema>;

/**
 * A validation pipeline: its YAML pipeline's name and signal, created and
 * deleted, never changed. `createdByUserId` is null once that account is
 * hard-deleted. Its pipeline name is configuration text. Its fields alone,
 * which the public API's shape extends
 * (public-api/validation-pipelines.ts).
 */
export const ValidationPipelineFieldsSchema = z
  .object({
    id: z.string().uuid(),
    configurationId: z.string().uuid(),
    versionId: z.string().uuid(),
    pipeline: z.string().max(TEST_RUN_PIPELINE_MAXIMUM_LENGTH),
    signal: z.enum(TEST_RUN_SIGNALS),
    createdByUserId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

/** Whether a pipeline's signal is its name's first part: the check every pipeline schema refines with. */
export function isSignalOfPipeline(pipeline: { pipeline: string; signal: TestRunSignal }): boolean {
  return signalOfPipeline(pipeline.pipeline) === pipeline.signal;
}

/** ValidationPipelineFieldsSchema, its signal checked against its name. */
export const ValidationPipelineSchema = ValidationPipelineFieldsSchema.refine(isSignalOfPipeline, {
  message: "The pipeline's signal must be its name's first part.",
  path: ["signal"],
});

export type ValidationPipeline = z.infer<typeof ValidationPipelineSchema>;

/** `GET …/validation-pipelines`: the version's validation pipelines the caller can see, oldest first. */
export const ValidationPipelinesResponseSchema = z.object({ validationPipelines: z.array(ValidationPipelineSchema) }).strict();

export type ValidationPipelinesResponse = z.infer<typeof ValidationPipelinesResponseSchema>;

/** `POST …/validation-pipelines` (201): the validation pipeline. */
export const ValidationPipelineResponseSchema = z.object({ validationPipeline: ValidationPipelineSchema }).strict();

export type ValidationPipelineResponse = z.infer<typeof ValidationPipelineResponseSchema>;

/**
 * A rule as a run copies it when it is queued: frozen on the run
 * (test_runs.validation_rules, in position order), what the evaluator
 * checks after the tester answers. Configuration text.
 */
export const ValidationRuleSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    position: z.number().int().min(1),
    kind: z.enum(VALIDATION_RULE_KINDS),
    target: z.enum(VALIDATION_RULE_TARGETS),
    pattern: StoredRuleTextSchema.nullable(),
    ottl: ValidationRuleOttlSchema.nullable(),
    name: atMostCodePoints(VALIDATION_RULE_NAME_MAXIMUM_LENGTH),
    description: atMostCodePoints(VALIDATION_RULE_DESCRIPTION_MAXIMUM_LENGTH),
  })
  .strict()
  .superRefine(checkRuleContent);

export type ValidationRuleSnapshot = z.infer<typeof ValidationRuleSnapshotSchema>;

/*
 * A rule's result: the evaluator's answer for one rule, matched by its id.
 * Its bounds are the evaluator's contract's
 * (services/ottl-evaluator/openapi.yaml's Result), counted in code points as
 * JSON Schema's maxLength counts them; the evaluator's own (bytes) are
 * tighter. Snippets and samples are configuration text.
 */

/** A rule's message: its error, or its advisory. At most 4,096 characters. */
const ResultMessageSchema = z
  .string()
  .min(1)
  .pipe(atMostCodePoints(4_096));

/** Where a match is: an element of the output and the JSON path inside it, or a line of the log. */
const MatchRecordSchema = z.union([
  z
    .object({
      /** The element of the output's records (0 for a single document); null outside every record. */
      index: z.number().int().min(0).nullable(),
      path: atMostCodePoints(200),
    })
    .strict(),
  z.object({ line: z.number().int().min(1) }).strict(),
]);

/** A not-contains rule's match: its text (at most 200 bytes), and 40 bytes either side on its line. */
const MatchSchema = z
  .object({
    text: atMostCodePoints(200),
    textTruncated: z.boolean(),
    before: atMostCodePoints(40),
    after: atMostCodePoints(40),
    record: MatchRecordSchema,
  })
  .strict();

/** A record an OTTL rule held against it: its index, why, and a snippet of it (at most 200 bytes). */
const MissSchema = z
  .object({
    index: z.number().int().min(0),
    reason: z.string(),
    snippet: atMostCodePoints(200),
  })
  .strict();

const nonNegativeInteger = z.number().int().min(0);

/** Why a rule failed, by `kind`. */
export const ValidationRuleResultDetailSchema = z.discriminatedUnion("kind", [
  /** A contains rule found nothing in what it searched. */
  z
    .object({
      kind: z.literal("no_match"),
      source: z.enum(VALIDATION_RULE_TARGETS),
      searchedCharacters: nonNegativeInteger,
    })
    .strict(),
  /** A not-contains rule found its text: up to five matches, and how many there were (counted to 100,000). */
  z
    .object({
      kind: z.literal("unexpected_match"),
      source: z.enum(VALIDATION_RULE_TARGETS),
      totalMatchCount: z.number().int().min(1).max(100_000),
      moreMatches: z.boolean(),
      matches: z.array(MatchSchema).min(1).max(5),
    })
    .strict(),
  /** An OTTL rule's records didn't hold as its quantifier asks: up to five of them. */
  z
    .object({
      kind: z.literal("record_mismatch"),
      context: z.enum(OTTL_CONTEXTS),
      totalCount: nonNegativeInteger,
      matchedCount: nonNegativeInteger,
      missCount: nonNegativeInteger,
      misses: z.array(MissSchema).max(5),
    })
    .strict(),
  /** A distinct rule's count of distinct values failed its comparison: up to five of them. */
  z
    .object({
      kind: z.literal("distinct_mismatch"),
      totalCount: nonNegativeInteger,
      matchedCount: nonNegativeInteger,
      distinctCount: nonNegativeInteger,
      samples: z.array(atMostCodePoints(120)).max(5),
    })
    .strict(),
]);

export type ValidationRuleResultDetail = z.infer<typeof ValidationRuleResultDetailSchema>;

/**
 * One rule's result. `passed` is strictly a boolean (the run's outcome check
 * reads it). A rule that erred on its own (an OTTL type error, "Not checked:
 * …") failed: `error` holds its message and `detail` is null. A rule that
 * passed has no detail. The advisory says why a pass may mislead (an `all`
 * over zero records, a truncated output), or explains a failure that has no
 * detail (a not-contains regex whose matches were all empty text).
 */
export const ValidationRuleResultSchema = z
  .object({
    id: z.string().uuid(),
    passed: z.boolean(),
    error: ResultMessageSchema.nullable(),
    advisory: ResultMessageSchema.nullable(),
    detail: ValidationRuleResultDetailSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.error !== null && (result.passed || result.detail !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A rule with an error failed, and has no detail.",
        path: ["error"],
      });
    }
    if (result.passed && result.detail !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A rule that passed has no detail.", path: ["detail"] });
    }
  });

export type ValidationRuleResult = z.infer<typeof ValidationRuleResultSchema>;

/** The words, exactly, of 409 `validation_pipeline_exists`. */
export function validationPipelineExistsMessage(pipeline: string): string {
  return `Pipeline "${pipeline}" already has a validation pipeline for this version.`;
}

/** The words, exactly, for a pipeline's 201st rule, 409 `validation_rule_limit_reached`. */
export const VALIDATION_RULE_LIMIT_MESSAGE = `A validation pipeline can have at most ${VALIDATION_RULES_PER_PIPELINE_MAXIMUM} rules.`;

/** The words, exactly, for saving a rule that needs checking while the evaluator can't be reached, 503 `rules_unavailable`. */
export const RULES_UNAVAILABLE_AT_SAVE_MESSAGE = "Rules can't be checked right now. Try again shortly.";

/** The words, exactly, for queuing a run with rules while the evaluator is known down, 503 `rules_unavailable`. */
export const RULES_UNAVAILABLE_AT_QUEUE_MESSAGE = "Validation rules can't be checked right now. Try again later.";

/** The words, exactly, when a run whose rules the evaluator couldn't check ends Error, its code `rules_unavailable`. */
export const RULES_UNAVAILABLE_RUN_MESSAGE = "Validation rules couldn't be checked: the rule evaluator is unavailable.";

/**
 * The validation rules' own codes, none of them `validation_unavailable` or
 * `validation_rate_limited` (the collector validator's). They also answer the
 * organization's, the configurations' and the envelope's shared ones
 * (`invalid_request`, which a context its pipeline's signal doesn't allow
 * gets too):
 * - `validation_pipeline_not_found`, `validation_rule_not_found` (404): one
 *   the caller can't see (another member's draft's, another version's,
 *   another organization's), or an id that isn't a canonical UUID, alike;
 * - `validation_pipeline_exists` (409, validationPipelineExistsMessage);
 * - `validation_rule_limit_reached` (409, VALIDATION_RULE_LIMIT_MESSAGE);
 * - `validation_rule_invalid` (400): the evaluator's message as it words it
 *   ("OTTL syntax error: …", "Invalid regex: …", or a problem in its own
 *   words);
 * - `rules_unavailable` (503 at Save and at queue; and a run's error code
 *   when the evaluator couldn't check its rules);
 * - `validation_rule_rate_limited` (429): more than
 *   VALIDATION_RULE_CHECKS_PER_MINUTE_PER_USER checked saves a minute.
 */
export const VALIDATION_RULES_ERROR_CODES = [
  "validation_pipeline_not_found",
  "validation_rule_not_found",
  "validation_pipeline_exists",
  "validation_rule_limit_reached",
  "validation_rule_invalid",
  "rules_unavailable",
  "validation_rule_rate_limited",
] as const;

export type ValidationRulesErrorCode = (typeof VALIDATION_RULES_ERROR_CODES)[number];
