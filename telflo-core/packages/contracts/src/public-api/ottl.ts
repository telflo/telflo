import { z } from "zod";
import { ValidateConfigurationVersionRequestSchema } from "../configurations.js";
import { OTTL_CONTEXTS } from "../validation-rules.js";

/*
 * The public surface's request and response shapes for OTTL lint (route 16):
 * strict Zod schemas, camelCase, reusing the platform's contracts where they
 * already hold a field. Exported from the package's index with `export *`.
 */

/** How many expressions one lint may check, in all (the evaluator's cap). */
export const PUBLIC_OTTL_LINT_MAXIMUM_EXPRESSIONS = 200;

/** An expression's longest text (the evaluator's 8,192). */
export const PUBLIC_OTTL_LINT_EXPRESSION_MAXIMUM_LENGTH = 8_192;

/** The kinds of OTTL text a lint checks. */
export const PUBLIC_OTTL_LINT_KINDS = ["condition", "statement", "valueExpression"] as const;

export type PublicOttlLintKind = (typeof PUBLIC_OTTL_LINT_KINDS)[number];

const ExpressionsSchema = z.array(z.string().max(PUBLIC_OTTL_LINT_EXPRESSION_MAXIMUM_LENGTH)).max(PUBLIC_OTTL_LINT_MAXIMUM_EXPRESSIONS);

/**
 * `POST /api/public/v1/ottl/lint`, in one of two modes:
 * - `{ yaml }`: a collector configuration (a version's validation's text);
 *   every OTTL expression in it is linted, each against its component's
 *   context;
 * - `{ context, conditions?, statements?, valueExpressions? }`: the
 *   expressions against one context, 1 to 200 in all.
 * Both, neither, an unknown context and more than 200 expressions are 400
 * `invalid_request`. The body is at most 2 MiB as sent (413
 * `payload_too_large` past it, before this schema runs): with long
 * expressions, or ones JSON escapes, that is the effective bound, below the
 * 200 × 8,192 characters this schema takes.
 */
export const PublicOttlLintRequestSchema = z
  .object({
    yaml: ValidateConfigurationVersionRequestSchema.shape.yaml.optional(),
    context: z.enum(OTTL_CONTEXTS).optional(),
    conditions: ExpressionsSchema.optional(),
    statements: ExpressionsSchema.optional(),
    valueExpressions: ExpressionsSchema.optional(),
  })
  .strict()
  .superRefine((body, context) => {
    const lists = [body.conditions, body.statements, body.valueExpressions];
    const total = lists.reduce((sum, list) => sum + (list?.length ?? 0), 0);
    if (body.yaml !== undefined) {
      if (body.context !== undefined || lists.some((list) => list !== undefined)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Send either yaml, or a context with expressions, not both." });
      }
      return;
    }
    if (body.context === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["context"], message: "Send yaml, or a context with expressions." });
    }
    if (total < 1 || total > PUBLIC_OTTL_LINT_MAXIMUM_EXPRESSIONS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Send from 1 to 200 conditions, statements and value expressions in all." });
    }
  });

export type PublicOttlLintRequest = z.infer<typeof PublicOttlLintRequestSchema>;

/**
 * One expression's verdict. `input` is the caller's own expression, from
 * the request. `error` is the evaluator's words when it isn't valid (a
 * parser's message after "OTTL syntax error: "). `context` is the context it
 * was linted against; `location` where it is in the YAML (`null` for an
 * expression sent as such); `note` says a transform's flat statement's
 * context was inferred, or that a transform-only function's arguments
 * weren't checked.
 */
export const PublicOttlLintItemSchema = z
  .object({
    kind: z.enum(PUBLIC_OTTL_LINT_KINDS),
    index: z.number().int().min(0),
    input: z.string(),
    valid: z.boolean(),
    error: z.string().nullable(),
    context: z.enum(OTTL_CONTEXTS).nullable(),
    location: z.string().nullable(),
    note: z.string().nullable(),
  })
  .strict();

export type PublicOttlLintItem = z.infer<typeof PublicOttlLintItemSchema>;

/**
 * The lint's answer: `valid` when every item is, the evaluator's OTTL
 * version (`null` when the evaluator wasn't asked: no expression, or every
 * one over 8,192 characters), how many expressions were
 * checked, each one's verdict (in the YAML's order, `index` counting
 * across the YAML; in the request's order, `index` within its kind), and
 * what in a YAML couldn't be checked (`skipped`).
 */
export const PublicOttlLintResponseSchema = z
  .object({
    valid: z.boolean(),
    ottlVersion: z.string().nullable(),
    checked: z.number().int().min(0),
    items: z.array(PublicOttlLintItemSchema),
    skipped: z.array(z.string()),
  })
  .strict();

export type PublicOttlLintResponse = z.infer<typeof PublicOttlLintResponseSchema>;
