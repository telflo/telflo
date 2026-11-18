import { z } from "zod";
import { hasUnstorableCharacter, utf8ByteLength } from "./configurations.js";
import { codePointLength } from "./test-run-pipelines.js";
import { trimmedDescriptionSchema, trimmedNameSchema } from "./test-suites.js";
import { ruleTextSchema, trimRuleText, VALIDATION_RULE_TEXT_MAXIMUM_BYTES } from "./validation-rules.js";

/*
 * The regex library's endpoints (D15b decisions 7 and 8; details 16 to 18;
 * Preflight rulings 3 and 4): named regex patterns the validation-rule
 * picker offers, global as test templates are.
 *
 * - Members, signed in with the current terms (a product admin with or
 *   without them, as the test templates' list): `GET /api/v1/test-regexes`,
 *   every entry, ordered by category, then name, then id, under the
 *   database's collation.
 * - Product admins only (`product_admin_required` otherwise):
 *   `POST /api/v1/test-regexes`, `PATCH /api/v1/test-regexes/:testRegexId`
 *   and `DELETE …/:testRegexId` (hard). A create, and a change whose regex
 *   differs from the stored one, is checked under the OTTL evaluator's RE2
 *   first, counted on the person's own checked saves
 *   (VALIDATION_RULE_CHECKS_PER_MINUTE_PER_USER a minute, apart from every
 *   organization's: Preflight ruling 4).
 *
 * An entry's name, category, description and regex are configuration text
 * (ADR 0024): JSON bodies only, never a URL, a log line or an audit row.
 * Their bounds are migration 031's checks. The table trims ASCII's
 * whitespace only; these schemas trim and refuse whitespace as JavaScript
 * and Go's `unicode.IsSpace` both count it (as the rules' texts are judged
 * blank: D15a Preflight ruling 6), so nothing the evaluator or the web would
 * call blank is stored, and no write meets a check violation.
 */

/** An entry's name, after trimming: 1 to 200 characters, unique (ck_test_regex_name_length, uq_test_regex_name). */
export const TEST_REGEX_NAME_MAXIMUM_LENGTH = 200;

/** An entry's category, after trimming: 1 to 100 characters (ck_test_regex_category_length). */
export const TEST_REGEX_CATEGORY_MAXIMUM_LENGTH = 100;

/** An entry's description, after trimming: 1 to 2,000 characters, or none (null). */
export const TEST_REGEX_DESCRIPTION_MAXIMUM_LENGTH = 2_000;

/** An entry's regex: at most 8,192 bytes of UTF-8, a rule's pattern's bound (ck_test_regex_regex_length). */
export const TEST_REGEX_REGEX_MAXIMUM_BYTES = VALIDATION_RULE_TEXT_MAXIMUM_BYTES;

/** Decision 8's words, exactly: 409 `test_regex_name_taken`. */
export const TEST_REGEX_NAME_TAKEN_MESSAGE = "A regex with that name already exists.";

/**
 * `text` without whitespace at either end, as JavaScript's `trim` and Go's
 * `unicode.IsSpace` (trimRuleText) count it, until neither finds more:
 * U+0085 goes, which `trim` keeps, and U+FEFF, which Go keeps. What the
 * name, category and description schemas store; the web's dialog trims
 * with it too, so it judges blank, and compares, what the API will
 * (D15b Ruling 22).
 */
export function trimLibraryText(text: string): string {
  let current = text;
  for (;;) {
    const next = trimRuleText(current.trim());
    if (next === current) return current;
    current = next;
  }
}

/** A name: trimmed (trimLibraryText), 1 to 200 characters, nothing Postgres can't store. */
export const TestRegexNameSchema = z
  .string()
  .transform(trimLibraryText)
  .pipe(trimmedNameSchema(TEST_REGEX_NAME_MAXIMUM_LENGTH));

/** A category: free text, trimmed, 1 to 100 characters, nothing Postgres can't store. */
export const TestRegexCategorySchema = z
  .string()
  .transform(trimLibraryText)
  .pipe(
    z
      .string()
      .min(1, "The category can't be empty.")
      .max(TEST_REGEX_CATEGORY_MAXIMUM_LENGTH)
      .refine((category) => !hasUnstorableCharacter(category), "The category can't contain U+0000 or a lone surrogate."),
  );

/** A description: trimmed, at most 2,000 characters; `''`, only whitespace and `null` are none (null). */
export const TestRegexDescriptionSchema = z
  .string()
  .transform(trimLibraryText)
  .pipe(trimmedDescriptionSchema(TEST_REGEX_DESCRIPTION_MAXIMUM_LENGTH))
  .transform((description) => (description === "" ? null : description))
  .nullable();

/**
 * A regex, as it is sent and stored: never trimmed (its spaces are part of
 * it), refused when blank, at most 8,192 bytes: a rule's pattern
 * (ruleTextSchema), so every entry is a pattern a regex rule takes.
 */
export const TestRegexRegexSchema = ruleTextSchema("regex");

/**
 * `POST /api/v1/test-regexes`, product admins only: the regex dialog's
 * fields. The description may be left out (none). Strict.
 * A name another entry has is 409 `test_regex_name_taken`; a regex RE2
 * doesn't take is 400 `test_regex_invalid`, with the evaluator's words.
 */
export const CreateTestRegexRequestSchema = z
  .object({
    name: TestRegexNameSchema,
    category: TestRegexCategorySchema,
    description: TestRegexDescriptionSchema.default(null),
    regex: TestRegexRegexSchema,
  })
  .strict();

/** What a client sends: `description` may be left out. */
export type CreateTestRegexRequest = z.input<typeof CreateTestRegexRequestSchema>;

/**
 * `PATCH /api/v1/test-regexes/:testRegexId`, product admins only: a field
 * left out stays as it is; a description of `''`, only whitespace or `null`
 * removes it. None at all (`{}`), or none different, changes nothing and
 * answers the entry as it is. Only a regex that differs from the stored one
 * is checked (and counted). Strict.
 */
export const UpdateTestRegexRequestSchema = z
  .object({
    name: TestRegexNameSchema.optional(),
    category: TestRegexCategorySchema.optional(),
    description: TestRegexDescriptionSchema.optional(),
    regex: TestRegexRegexSchema.optional(),
  })
  .strict();

export type UpdateTestRegexRequest = z.input<typeof UpdateTestRegexRequestSchema>;

/** A string of at most `maximum` code points, as Postgres's char_length counts: a stored row always serialises. */
const atMostCodePoints = (maximum: number) =>
  z.string().refine((text) => codePointLength(text) <= maximum, {
    message: `String must contain at most ${maximum} character(s)`,
  });

/**
 * An entry. `description` is null for none. The timestamps are ISO 8601,
 * from the API's clock. Its name, category, description and regex are
 * configuration text.
 */
export const TestRegexSchema = z
  .object({
    id: z.string().uuid(),
    name: atMostCodePoints(TEST_REGEX_NAME_MAXIMUM_LENGTH),
    category: atMostCodePoints(TEST_REGEX_CATEGORY_MAXIMUM_LENGTH),
    description: atMostCodePoints(TEST_REGEX_DESCRIPTION_MAXIMUM_LENGTH).nullable(),
    regex: z.string().refine((regex) => utf8ByteLength(regex) <= TEST_REGEX_REGEX_MAXIMUM_BYTES, {
      message: "The regex is longer than 8,192 bytes.",
    }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type TestRegex = z.infer<typeof TestRegexSchema>;

/** `GET /api/v1/test-regexes`: every entry, ordered by category, then name, then id. */
export const TestRegexesResponseSchema = z.object({ testRegexes: z.array(TestRegexSchema) }).strict();

export type TestRegexesResponse = z.infer<typeof TestRegexesResponseSchema>;

/** `POST /api/v1/test-regexes` (201) and `PATCH …/:testRegexId`: the entry. */
export const TestRegexResponseSchema = z.object({ testRegex: TestRegexSchema }).strict();

export type TestRegexResponse = z.infer<typeof TestRegexResponseSchema>;

/**
 * The regex library's own error codes (detail 17):
 * - `test_regex_not_found` (404): an id no entry has, or one that isn't a
 *   canonical UUID, alike;
 * - `test_regex_name_taken` (409, TEST_REGEX_NAME_TAKEN_MESSAGE);
 * - `test_regex_invalid` (400): the evaluator's words ("Invalid regex: …"),
 *   each problem in `details.problems` with its field, `regex`.
 *
 * Its check's refusals are the rules' check's (VALIDATION_RULES_ERROR_CODES,
 * Preflight ruling 4): 503 `rules_unavailable` and 429
 * `validation_rule_rate_limited`, in their words; a member's write is 403
 * `product_admin_required` (IDENTITY_ERROR_CODES).
 */
export const TEST_REGEX_ERROR_CODES = ["test_regex_not_found", "test_regex_name_taken", "test_regex_invalid"] as const;

export type TestRegexErrorCode = (typeof TEST_REGEX_ERROR_CODES)[number];
