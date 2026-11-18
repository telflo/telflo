import { z } from "zod";
import { FLEET_NAME_PATTERN, FleetActorSchema } from "./fleets.js";

/*
 * The platform's organization variables and variable groups (D20 decisions
 * 2, 3, 11, 15, 31 and 37), under /api/v1/organizations/{organizationId}:
 * `variables` and `variable-groups`, and a variable group's overrides. The
 * opamp-server holds them (Q80); the platform passes them through. Every
 * member of the organization reads and writes them (decision 37).
 *
 * There are no secret variables (Q88): a value is configuration text like a
 * configuration's YAML (ADR 0024). A variable's value, name and
 * description, and a variable group's name and description, never reach a
 * log line, an error message, an audit row or a URL (decision 35).
 *
 * The bounds are the opamp-server's (openapi.yaml's VariableName,
 * VariableValue, VariableDescription and VariableGroupName; Q90, as Q104
 * lowered the count and the value's length), every
 * length counted in code points as its `char_length` counts them (D20
 * Preflight ruling 23). A name has two patterns: the platform's screens
 * keep an UPPER_CASE rule for a name they create or rename
 * (VARIABLE_NAME_PATTERN, Q81), while a reply's name, and a name in the
 * `variables_undefined` details, follows the server's own grammar
 * (VARIABLE_REFERENCE_NAME_PATTERN), which takes lowercase too.
 */

/** The most variables an organization may have (Q104; Q90's 500 lowered). */
export const ORGANIZATION_VARIABLES_MAXIMUM = 150;
/** The most variable groups an organization may have (Q90). */
export const VARIABLE_GROUPS_MAXIMUM = 100;
/** A variable's name: at most 128 characters (Q81, Ruling 51). */
export const VARIABLE_NAME_MAXIMUM_LENGTH = 128;
/** A value: 0 to 1,024 characters, on one line (Q87; Q104, Q90's 4,096 lowered). */
export const VARIABLE_VALUE_MAXIMUM_LENGTH = 1024;
/** A variable's or a variable group's description: 1 to 1,000 characters, or none. */
export const VARIABLE_DESCRIPTION_MAXIMUM_LENGTH = 1000;
/** A variable group's name: 1 to 200 characters. */
export const VARIABLE_GROUP_NAME_MAXIMUM_LENGTH = 200;
/** The most entries an in-use or undefined detail lists, each with its exact total (Q102). */
export const VARIABLE_DETAILS_MAXIMUM_LISTED = 100;

/** A name the platform creates or renames to: UPPER_CASE (Q81). */
export const VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * The opamp-server's grammar for a variable's name (openapi.yaml's
 * VariableName, the renderer's NAME): an ASCII letter or an underscore,
 * then ASCII letters, digits or underscores. A reply's name follows it.
 */
export const VARIABLE_REFERENCE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * openapi.yaml's VariableValue: one line, with no control character (C0,
 * DEL or C1: a tab, a line feed and a carriage return among them) and
 * neither U+2028 nor U+2029 (written here as escapes, never the characters).
 */
export const VARIABLE_VALUE_PATTERN =
  // eslint-disable-next-line no-control-regex -- the contract's own pattern refuses control characters
  /^[^\x00-\x1f\x7f-\x9f\u2028\u2029]*$/u;

/** The number of code points of `value`: what openapi.yaml's lengths count. */
function codePointLength(value: string): number {
  return [...value].length;
}

const uuid = z.string().uuid();

/** A time in a reply: UTC, ISO 8601. */
const instant = z.string().datetime();

function nameSchema(pattern: RegExp) {
  return z
    .string()
    .refine((value) => {
      const length = codePointLength(value);
      return length >= 1 && length <= VARIABLE_NAME_MAXIMUM_LENGTH;
    }, `Must be 1 to ${VARIABLE_NAME_MAXIMUM_LENGTH} characters.`)
    .refine((value) => pattern.test(value), "Use letters, digits and underscores, starting with a letter.");
}

/** A name the platform creates or renames to: 1 to 128 characters, UPPER_CASE. */
export const VariableNameSchema = nameSchema(VARIABLE_NAME_PATTERN);

/** A variable's name in a reply or a detail: the opamp-server's grammar, 1 to 128 characters. */
export const VariableReferenceNameSchema = nameSchema(VARIABLE_REFERENCE_NAME_PATTERN);

/** A value: 0 to 1,024 characters on one line. Kept as sent, never trimmed. */
export const VariableValueSchema = z
  .string()
  .refine((value) => codePointLength(value) <= VARIABLE_VALUE_MAXIMUM_LENGTH, `Must be at most ${VARIABLE_VALUE_MAXIMUM_LENGTH} characters.`)
  .refine((value) => VARIABLE_VALUE_PATTERN.test(value), "Must be one line, with no control character.");

/** 1 to `maximum` characters, with no whitespace at either end and no control character (openapi.yaml's pattern). */
function displayTextSchema(maximum: number) {
  return z
    .string()
    .refine((value) => {
      const length = codePointLength(value);
      return length >= 1 && length <= maximum;
    }, `Must be 1 to ${maximum} characters.`)
    .refine(
      (value) => FLEET_NAME_PATTERN.test(value),
      "Must not start or end with a space, or hold a control character.",
    );
}

/** A variable's or a variable group's description: 1 to 1,000 characters, no space at either end; null for none. */
export const VariableDescriptionSchema = displayTextSchema(VARIABLE_DESCRIPTION_MAXIMUM_LENGTH).nullable();

/** A variable group's name: 1 to 200 characters, no space at either end. */
export const VariableGroupNameSchema = displayTextSchema(VARIABLE_GROUP_NAME_MAXIMUM_LENGTH);

// ---------------------------------------------------------------------------
// Requests.

/**
 * A variable's create: the browser's own id makes a retry safe (the same
 * id, name, value and description answers the variable again, Q93).
 */
export const CreateOrganizationVariableRequestSchema = z
  .object({
    id: uuid,
    name: VariableNameSchema,
    value: VariableValueSchema,
    description: VariableDescriptionSchema,
  })
  .strict();

export type CreateOrganizationVariableRequest = z.infer<typeof CreateOrganizationVariableRequestSchema>;

/** A variable's rename, new value or description (null removes it): at least one field. */
export const UpdateOrganizationVariableRequestSchema = z
  .object({
    name: VariableNameSchema.optional(),
    value: VariableValueSchema.optional(),
    description: VariableDescriptionSchema.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Give at least one field.");

export type UpdateOrganizationVariableRequest = z.infer<typeof UpdateOrganizationVariableRequestSchema>;

/** A variable group's create, under the browser's own id (a retry is safe). It starts with no override. */
export const CreateVariableGroupRequestSchema = z
  .object({
    id: uuid,
    name: VariableGroupNameSchema,
    description: VariableDescriptionSchema,
  })
  .strict();

export type CreateVariableGroupRequest = z.infer<typeof CreateVariableGroupRequestSchema>;

/** A variable group's rename or description (null removes it): at least one field. */
export const UpdateVariableGroupRequestSchema = z
  .object({
    name: VariableGroupNameSchema.optional(),
    description: VariableDescriptionSchema.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Give at least one field.");

export type UpdateVariableGroupRequest = z.infer<typeof UpdateVariableGroupRequestSchema>;

/** A variable group's override of one variable: its value there. */
export const VariableGroupOverrideRequestSchema = z.object({ value: VariableValueSchema }).strict();

export type VariableGroupOverrideRequest = z.infer<typeof VariableGroupOverrideRequestSchema>;

// ---------------------------------------------------------------------------
// Responses.

/** One of the organization's variables, its value included (no secrets, Q88); who changed it last and when (Q94). */
export const OrganizationVariableSchema = z
  .object({
    id: uuid,
    name: VariableReferenceNameSchema,
    value: VariableValueSchema,
    description: VariableDescriptionSchema,
    changedBy: FleetActorSchema.nullable(),
    changedAt: instant,
  })
  .strict();

export type OrganizationVariable = z.infer<typeof OrganizationVariableSchema>;

/** Every variable of the organization, by name. */
export const OrganizationVariablesResponseSchema = z
  .object({ variables: z.array(OrganizationVariableSchema).max(ORGANIZATION_VARIABLES_MAXIMUM) })
  .strict();

export type OrganizationVariablesResponse = z.infer<typeof OrganizationVariablesResponseSchema>;

export const OrganizationVariableResponseSchema = z.object({ variable: OrganizationVariableSchema }).strict();

export type OrganizationVariableResponse = z.infer<typeof OrganizationVariableResponseSchema>;

/**
 * One of the organization's variable groups (decision 3): its overrides
 * counted, what uses it (the collector groups bound to it and the
 * collectors it is pinned on), and who changed it, or an override in it,
 * last and when.
 */
export const VariableGroupSchema = z
  .object({
    id: uuid,
    name: VariableGroupNameSchema,
    description: VariableDescriptionSchema,
    overrideCount: z.number().int().min(0).max(ORGANIZATION_VARIABLES_MAXIMUM),
    usage: z
      .object({
        collectorGroups: z.number().int().min(0),
        pinnedCollectors: z.number().int().min(0),
      })
      .strict(),
    changedBy: FleetActorSchema.nullable(),
    changedAt: instant,
  })
  .strict();

export type VariableGroup = z.infer<typeof VariableGroupSchema>;

/** A variable group's override of one variable, always with a value. */
export const VariableGroupOverrideSchema = z
  .object({
    variableId: uuid,
    value: VariableValueSchema,
    changedBy: FleetActorSchema.nullable(),
    changedAt: instant,
  })
  .strict();

export type VariableGroupOverride = z.infer<typeof VariableGroupOverrideSchema>;

/** Every variable group of the organization, by name. */
export const VariableGroupsResponseSchema = z
  .object({ variableGroups: z.array(VariableGroupSchema).max(VARIABLE_GROUPS_MAXIMUM) })
  .strict();

export type VariableGroupsResponse = z.infer<typeof VariableGroupsResponseSchema>;

export const VariableGroupResponseSchema = z.object({ variableGroup: VariableGroupSchema }).strict();

export type VariableGroupResponse = z.infer<typeof VariableGroupResponseSchema>;

/**
 * A variable group's read: the group and its overrides, by their variable's
 * name. A variable it doesn't override takes the organization's value.
 */
export const VariableGroupDetailSchema = z
  .object({
    variableGroup: VariableGroupSchema,
    overrides: z.array(VariableGroupOverrideSchema).max(ORGANIZATION_VARIABLES_MAXIMUM),
  })
  .strict();

export type VariableGroupDetail = z.infer<typeof VariableGroupDetailSchema>;

export const VariableGroupOverrideResponseSchema = z.object({ override: VariableGroupOverrideSchema }).strict();

export type VariableGroupOverrideResponse = z.infer<typeof VariableGroupOverrideResponseSchema>;

/**
 * Default 21's warning: the configurations, among those the member can
 * see, whose current draft references the variable's name.
 */
export const VariableDraftsResponseSchema = z
  .object({ configurations: z.array(z.object({ id: uuid, name: z.string() }).strict()) })
  .strict();

export type VariableDraftsResponse = z.infer<typeof VariableDraftsResponseSchema>;

// ---------------------------------------------------------------------------
// The refusals' details (Q102; Preflight rulings 26, 41 and 43): at most 100
// entries each, with exact totals. Every name the platform looks up is
// nullable: a lookup that fails or finds nothing leaves null, and the
// refusal stands.

/** A collector group in a detail: its fleet and its id, with their names where the platform found them. */
export const VariableUseGroupSchema = z
  .object({
    fleetId: uuid,
    fleetLabel: z.string().nullable(),
    groupId: uuid,
    groupName: z.string().nullable(),
  })
  .strict();

export type VariableUseGroup = z.infer<typeof VariableUseGroupSchema>;

/**
 * `variable_in_use`'s details (409): the used published versions that
 * reference the variable's name, each with the collector groups assigned it
 * and how many collectors are pinned to it, at most 100 entries in all (an
 * entry is one of a version's groups, or a version with no group); the
 * totals exact, over every use.
 */
export const VariableInUseDetailsSchema = z
  .object({
    usedBy: z
      .array(
        z
          .object({
            publishedVersionId: uuid,
            configurationId: uuid.nullable(),
            configurationName: z.string().nullable(),
            versionId: uuid.nullable(),
            versionNumber: z.number().int().min(1).nullable(),
            groups: z.array(VariableUseGroupSchema).max(VARIABLE_DETAILS_MAXIMUM_LISTED),
            pinnedCollectors: z.number().int().min(0),
          })
          .strict(),
      )
      .max(VARIABLE_DETAILS_MAXIMUM_LISTED),
    totalPublications: z.number().int().min(0),
    totalGroups: z.number().int().min(0),
    totalPinnedCollectors: z.number().int().min(0),
  })
  .strict();

export type VariableInUseDetails = z.infer<typeof VariableInUseDetailsSchema>;

/**
 * `variable_group_in_use`'s details (409): the collector groups bound to it,
 * at most 100 by fleet and then group, their exact total, and how many
 * collectors have it pinned.
 */
export const VariableGroupInUseDetailsSchema = z
  .object({
    collectorGroups: z.array(VariableUseGroupSchema).max(VARIABLE_DETAILS_MAXIMUM_LISTED),
    totalCollectorGroups: z.number().int().min(0),
    pinnedCollectors: z.number().int().min(0),
  })
  .strict();

export type VariableGroupInUseDetails = z.infer<typeof VariableGroupInUseDetailsSchema>;

/**
 * `variables_undefined`'s details (422): the names the published version
 * references that no variable of the organization has, at most 100 in
 * byte order, with their exact total.
 */
export const VariablesUndefinedDetailsSchema = z
  .object({
    names: z.array(VariableReferenceNameSchema).max(VARIABLE_DETAILS_MAXIMUM_LISTED),
    totalNames: z.number().int().min(0),
  })
  .strict();

export type VariablesUndefinedDetails = z.infer<typeof VariablesUndefinedDetailsSchema>;

/**
 * The variables routes' error codes (decision 37; platform choice P3: the
 * opamp-server's, plus `variables_unavailable` when it can't be reached).
 * `variables_undefined` and `variable_group_not_found` also answer the fleet
 * routes' assignments and pins.
 */
export const VARIABLE_ERROR_CODES = [
  "variable_not_found",
  "variable_group_not_found",
  "variable_name_taken",
  "variable_group_name_taken",
  "variable_in_use",
  "variable_group_in_use",
  "variable_limit_reached",
  "variable_group_limit_reached",
  "variable_conflict",
  "variable_group_conflict",
  "variables_undefined",
  "variables_unavailable",
] as const;

export type VariableErrorCode = (typeof VARIABLE_ERROR_CODES)[number];

/**
 * The words for "the organization's variables couldn't be reached" (D20
 * decision 1; one family, D20 Ruling 78): the opamp-server down,
 * slow or answering what its API doesn't document. Neutral, so they read
 * right after a read (a list, Validate, a test run's queue) and after a
 * write whose outcome is unknown alike: they claim neither that a change was
 * made nor that it wasn't (a dialog reloads what it shows behind them).
 *
 * VARIABLES_UNAVAILABLE_MESSAGE answers every 503 `variables_unavailable`:
 * the variables routes', Validate's and a test run's queue.
 */
export const VARIABLES_UNAVAILABLE_MESSAGE = "The organization's variables couldn't be reached. Try again.";

/**
 * The same words for a test run that ended `variables_unavailable` at its
 * dispatch (nothing was sent to the tester): "Run it again", as a run's
 * other failures say.
 */
export const VARIABLES_UNAVAILABLE_RUN_MESSAGE = "The organization's variables couldn't be reached. Run it again.";

/**
 * A publish's refusal (D20 Rulings 51, 55 and 71): 400 `invalid_request`,
 * its details naming `yaml`, for a text with a live `${org:NAME}` to a name
 * over 128 characters, which no variable can have. The editor shows the
 * same words.
 */
export const VARIABLE_REFERENCE_TOO_LONG_MESSAGE =
  "This configuration references an organization variable name over 128 characters, which no variable can have.";
