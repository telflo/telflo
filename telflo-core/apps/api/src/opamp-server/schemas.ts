import { z } from "zod";

// The opamp-server management API's replies, as zod schemas, one for each
// schema in vendor/opamp-server/openapi.yaml the platform reads
// (D11a decision 12). The bounds are the file's: lengths count code points,
// as JSON Schema's maxLength does, not UTF-16 units as zod's .max() would.
//
// Unknown fields are stripped rather than refused, unlike the file's
// `additionalProperties: false`: a field the server adds later (a nullable
// addition, spec decision 8's "cheap" change) must not break a platform
// that hasn't learned it yet. The fake validates the server's side of the
// contract strictly, against the file itself.

/** openapi.yaml's Uuid: 8-4-4-4-12 hex digits, either case. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const uuid = z.string().regex(UUID_PATTERN);

/** A string of `min` to `max` code points, with no U+0000. */
function text(min: number, max: number) {
  return z
    .string()
    .refine((value) => !value.includes("\u0000"), "must not contain U+0000")
    .refine((value) => {
      const length = [...value].length;
      return length >= min && length <= max;
    }, `must be ${min} to ${max} characters`);
}

/** Replies give times in UTC with milliseconds (openapi.yaml). */
const instant = z.string().datetime({ precision: 3 });

const configurationSchema = z.object({ id: uuid, name: text(1, 200) });

const versionSchema = z.object({
  id: uuid,
  number: z.number().int().min(1).max(2_147_483_647),
  label: text(1, 80).nullable(),
});

const actorSchema = z.object({ id: uuid, email: text(1, 320) }).nullable();

/**
 * openapi.yaml's Collector (D13a decision 7): both fields required, each in
 * the file's format and at most 64 characters; never null. The patterns are
 * the file's, with [0-9] rather than \d, as the server's and the database's.
 */
export const collectorSchema = z.object({
  distribution: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  version: z
    .string()
    .max(64)
    .regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
});

const summaryFields = {
  id: uuid,
  organizationId: uuid,
  configuration: configurationSchema,
  version: versionSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  publishedBy: actorSchema,
  publishedAt: instant,
  receivedAt: instant,
  collector: collectorSchema,
};

/** openapi.yaml's Publication: a stored publication, with its YAML. */
export const publicationSchema = z.object({
  ...summaryFields,
  // 1 MiB of UTF-8 at most; maxLength counts characters, as the file's does.
  yaml: text(1, 1_048_576),
});

/** openapi.yaml's PublicationSummary: a stored publication without its YAML. */
export const publicationSummarySchema = z.object(summaryFields);

/** openapi.yaml's PublicationList: one page of a configuration's publications. */
export const publicationListSchema = z.object({
  publications: z.array(publicationSummarySchema).max(100),
  nextCursor: z.string().nullable(),
});

/** openapi.yaml's OrganizationIdReply: the id POST registered, or found registered. */
export const organizationIdReplySchema = z.object({ organizationId: uuid });

/** openapi.yaml's Organization: a registered organization, as GET and PATCH answer it. */
export const organizationSchema = z.object({
  organizationId: uuid,
  // Display-only, 1 to 400 characters (D11a decision 20).
  name: text(1, 400),
  createdAt: instant,
  updatedAt: instant,
});

// ---------------------------------------------------------------------------
// D16a's fleet model (D16b decision 12, Preflight ruling 3): fleets,
// collector groups, enrollment tokens, collectors, limits and a
// configuration's usage. Bounds are exactly the file's schema bounds, no
// stricter: an array without maxItems has no max here, and a bound the file
// gives only in prose (an error text's 8 KiB) is left out.

/** A string of at least `min` and at most `max` code points (no max when undefined). */
function codePoints(min: number, max?: number) {
  return z.string().refine((value) => {
    const length = [...value].length;
    return length >= min && (max === undefined || length <= max);
  }, max === undefined ? `must be at least ${min} characters` : `must be ${min} to ${max} characters`);
}

/**
 * openapi.yaml's pattern for a fleet's label, a collector group's name and
 * a collector's name, character for character (schemas.test.ts holds them
 * equal): no whitespace at either end (Go's unicode.IsSpace) and no control
 * character anywhere (unicode.IsControl). Read with the `u` flag, as code
 * points.
 */
export const NAME_PATTERN_SOURCE =
  "^[^\\x00-\\x20\\x7f-\\xa0  -     　]" +
  "([^\\x00-\\x1f\\x7f-\\x9f]*[^\\x00-\\x20\\x7f-\\xa0  -     　])?$";

export const NAME_PATTERN = new RegExp(NAME_PATTERN_SOURCE, "u");

/** A label or a name: 1 to `max` code points in NAME_PATTERN. */
function displayName(max: number) {
  return codePoints(1, max).refine((value) => NAME_PATTERN.test(value), "must match the name pattern");
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().min(0);

export const fleetTypeSchema = z.enum(["server", "kubernetes-supervisor"]);
export const fleetStatusSchema = z.enum(["active", "archived"]);

const fleetFields = {
  id: uuid,
  organizationId: uuid,
  label: displayName(80),
  type: fleetTypeSchema,
  status: fleetStatusSchema,
  createdBy: actorSchema,
  createdAt: instant,
  updatedAt: instant,
};

/** openapi.yaml's Fleet: an update's reply, and a create's. */
export const fleetSchema = z.object(fleetFields);

/**
 * openapi.yaml's FleetRotateToken (D17a decision 17): the fleet's rotate
 * tokens at the read, or null when none is valid. Only FleetSummary holds it.
 */
const fleetRotateTokenSchema = z
  .object({
    expiresAt: instant.nullable(),
    graceEndsAt: instant.nullable(),
    validCount: z.number().int().min(1),
  })
  .nullable();

/**
 * openapi.yaml's FleetSummary: the fleet's collectors counted by liveness
 * and by drift, their latest last seen, and its rotate tokens' state.
 */
export const fleetSummarySchema = z.object({
  collectors: count,
  online: count,
  warning: count,
  unknown: count,
  offline: count,
  inSync: count,
  pending: count,
  failed: count,
  drifted: count,
  unassigned: count,
  lastSeenAt: instant.nullable(),
  rotateToken: fleetRotateTokenSchema,
});

/** openapi.yaml's FleetDetail: a fleet as its reads answer it, with its summary. */
export const fleetDetailSchema = z.object({ ...fleetFields, summary: fleetSummarySchema });

/** openapi.yaml's FleetList: one page of the organization's fleets. */
export const fleetListSchema = z.object({
  fleets: z.array(fleetDetailSchema).max(100),
  nextCursor: z.string().nullable(),
});

/** openapi.yaml's EnrollmentTokenBearer: a secret, never logged. */
const bearer = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);

/** openapi.yaml's CollectorGroup. */
export const collectorGroupSchema = z.object({
  id: uuid,
  fleetId: uuid,
  name: displayName(80),
  isDefault: z.boolean(),
  assignedPublicationId: uuid.nullable(),
  // CollectorGroupAnnotations: an object, or null; the file bounds its
  // canonical form's bytes in prose. The client's own data, passed through.
  annotations: z.record(z.unknown()).nullable(),
  // D20 (Task 6): the variable group its collectors' text is filled in with.
  variableGroupId: uuid.nullable(),
  createdAt: instant,
  updatedAt: instant,
});

/** openapi.yaml's CollectorGroupList: every group of a fleet (unpaged). */
export const collectorGroupListSchema = z.object({ groups: z.array(collectorGroupSchema) });

/** openapi.yaml's FleetUnchanged: a create's retry, without a bearer. */
export const fleetUnchangedSchema = z.object({ fleet: fleetSchema });

/** openapi.yaml's FleetCreated: the fleet, its Default group and both tokens' bearers. */
export const fleetCreatedSchema = z.object({
  fleet: fleetSchema,
  defaultGroup: collectorGroupSchema,
  tokens: z.object({
    default: z.object({ id: uuid, bearer }),
    rotate: z.object({ id: uuid, bearer, expiresAt: instant.nullable() }),
  }),
});

const enrollmentTokenKindSchema = z.enum(["default", "rotate"]);

const enrollmentTokenFields = {
  id: uuid,
  fleetId: uuid,
  kind: enrollmentTokenKindSchema,
  expiresAt: instant.nullable(),
  revokedAt: instant.nullable(),
  doRefresh: z.boolean(),
  createdBy: actorSchema,
  createdAt: instant,
};

/** openapi.yaml's EnrollmentToken: a token without its bearer, as a revoke answers it. */
export const enrollmentTokenSchema = z.object(enrollmentTokenFields);

/** openapi.yaml's EnrollmentTokenList: every token of a fleet (unpaged), each with its active collectors. */
export const enrollmentTokenListSchema = z.object({
  tokens: z.array(z.object({ ...enrollmentTokenFields, activeCollectors: count })),
});

/** openapi.yaml's EnrollmentTokenRotated: the new rotate token, with its bearer. It names no fleet. */
export const enrollmentTokenRotatedSchema = z.object({
  id: uuid,
  bearer,
  expiresAt: instant.nullable(),
  predecessorId: uuid.nullable(),
});

/** openapi.yaml's EnrollmentTokenRevealed: a fresh bearer for the token. It names no fleet. */
export const enrollmentTokenRevealedSchema = z.object({
  id: uuid,
  kind: enrollmentTokenKindSchema,
  bearer,
  expiresAt: instant.nullable(),
});

/** openapi.yaml's EnrollmentTokenEventList: one page of a fleet's token events, newest first (ids, the actor, the time; never a bearer). It names no fleet. */
export const enrollmentTokenEventListSchema = z.object({
  events: z
    .array(
      z.object({
        id: uuid,
        tokenId: uuid,
        event: z.enum(["issued", "viewed", "rotated", "revoked"]),
        actor: actorSchema,
        occurredAt: instant,
      }),
    )
    .max(100),
  nextCursor: z.string().nullable(),
});

/** openapi.yaml's CollectorInstancePin: a published version (the one kind since D16c), or null. */
export const collectorInstancePinSchema = z.object({ kind: z.enum(["publication"]), id: uuid }).nullable();

/** openapi.yaml's CollectorInstance: a fleet's collector, with what it reported of itself. */
export const collectorInstanceSchema = z.object({
  id: uuid,
  instanceUid: uuid,
  name: displayName(200),
  fleetId: uuid,
  groupId: uuid,
  pin: collectorInstancePinSchema,
  // D20 (Task 6): a variable group pinned on it, independent of the pin.
  pinnedVariableGroupId: uuid.nullable(),
  resolution: z
    .object({ from: z.enum(["pinnedPublication", "groupPublication"]), id: uuid, sha256 })
    .nullable(),
  served: z
    .object({
      kind: z.enum(["publication"]).nullable(),
      id: uuid.nullable(),
      sha256,
      at: instant.nullable(),
    })
    .nullable(),
  effective: z
    .object({
      sha256,
      status: z.enum(["applied", "applying", "failed"]),
      // The collector's own text; its 8 KiB is prose only.
      error: z.string().nullable(),
      at: instant,
    })
    .nullable(),
  reported: z.object({
    collectorVersion: z.string().nullable(),
    ip: z.string().nullable(),
    hostIp: z.string().nullable(),
    attributes: z.record(z.string(), z.string()).nullable(),
  }),
  enrollmentTokenId: uuid.nullable(),
  lastSeenAt: instant,
  liveness: z.enum(["online", "warning", "unknown", "offline"]),
  // 0.2.4 names it `sync` (0.1.0's `drift`), same values; the platform's own
  // contract keeps `drift` (D36-1 decision 15: modules/fleets/service.ts's
  // toCollector maps it).
  sync: z.enum(["inSync", "pending", "failed", "drifted", "unassigned"]),
  createdAt: instant,
  updatedAt: instant,
});

/** openapi.yaml's CollectorInstanceList: one page of a fleet's collectors. */
export const collectorInstanceListSchema = z.object({
  collectors: z.array(collectorInstanceSchema).max(100),
  nextCursor: z.string().nullable(),
});

/** openapi.yaml's CollectorInstanceBulkPinResult: the ids pinned as asked, and the ids the fleet doesn't hold. */
export const collectorInstanceBulkPinResultSchema = z.object({ updated: z.array(uuid), notFound: z.array(uuid) });

/** openapi.yaml's CollectorInstanceErrorList: one page of a collector's error history. */
export const collectorInstanceErrorListSchema = z.object({
  errors: z
    .array(
      z.object({
        id: uuid,
        reportedAt: instant,
        configSha256: sha256.nullable(),
        // The collector's own text, at least one character; its 8 KiB is prose only.
        message: codePoints(1),
      }),
    )
    .max(100),
  nextCursor: z.string().nullable(),
});

/** openapi.yaml's OrganizationLimits: null for a limit unset. */
export const organizationLimitsSchema = z.object({
  maxCollectors: z.number().int().min(0).max(2_147_483_647).nullable(),
  requestsPerMinute: z.number().int().min(1).max(2_147_483_647).nullable(),
});

/** openapi.yaml's ConfigurationUsage: what uses each of a configuration's published versions (unpaged). */
export const configurationUsageSchema = z.object({
  configurationId: uuid,
  inUse: z.boolean(),
  publications: z.array(
    z.object({
      id: uuid,
      version: versionSchema,
      publishedAt: instant,
      groups: z.array(z.object({ fleetId: uuid, groupId: uuid })),
      pinnedCollectors: count,
    }),
  ),
});

// ---------------------------------------------------------------------------
// D20's organization variables (decision 31; Task 9): variables, variable
// groups and their overrides, and the three guards' details. The bounds
// are the file's, in code points: a value is on one line, U+2028 and U+2029
// written as escapes here (Preflight ruling 1), never the characters.

/** openapi.yaml's VariableName: the renderer's grammar, ASCII only, case-sensitive. */
export const VARIABLE_NAME_PATTERN_SOURCE = "^[A-Za-z_][A-Za-z0-9_]*$";

const variableName = codePoints(1, 128).refine(
  (value) => new RegExp(VARIABLE_NAME_PATTERN_SOURCE).test(value),
  "must match the variable name pattern",
);

/**
 * openapi.yaml's VariableValue pattern, with its U+2028 and U+2029 as
 * escapes: no control character (C0, DEL or C1) and neither separator.
 * schemas.test.ts holds it equal to the file's.
 */
export const VARIABLE_VALUE_PATTERN_SOURCE = "^[^\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]*$";

const VARIABLE_VALUE_PATTERN = new RegExp(VARIABLE_VALUE_PATTERN_SOURCE, "u");

const variableValue = codePoints(0, 1024).refine((value) => VARIABLE_VALUE_PATTERN.test(value), "must be one line");

/** openapi.yaml's VariableDescription: NAME_PATTERN, 1 to 1,000 code points, or null. */
const variableDescription = displayName(1000).nullable();

const changedFields = { changedBy: actorSchema, changedAt: instant };

/** openapi.yaml's Variable: one of the organization's variables, its value included (no secrets, Q88). */
export const variableSchema = z.object({
  id: uuid,
  name: variableName,
  value: variableValue,
  description: variableDescription,
  ...changedFields,
});

/** openapi.yaml's VariableList: every variable of the organization (at most 150, Q104), unpaged. */
export const variableListSchema = z.object({ variables: z.array(variableSchema).max(150) });

/** openapi.yaml's VariableGroup: its overrides counted, and what uses it. */
export const variableGroupSchema = z.object({
  id: uuid,
  name: displayName(200),
  description: variableDescription,
  overrideCount: z.number().int().min(0).max(150),
  usage: z.object({ collectorGroups: count, pinnedCollectors: count }),
  ...changedFields,
});

/** openapi.yaml's VariableGroupList: every variable group of the organization (at most 100), unpaged. */
export const variableGroupListSchema = z.object({ variableGroups: z.array(variableGroupSchema).max(100) });

/** openapi.yaml's VariableGroupOverride: always with a value (a reset row is never answered). */
export const variableGroupOverrideSchema = z.object({ variableId: uuid, value: variableValue, ...changedFields });

/** openapi.yaml's VariableGroupDetail: the group and its overrides. */
export const variableGroupDetailSchema = z.object({
  variableGroup: variableGroupSchema,
  overrides: z.array(variableGroupOverrideSchema).max(150),
});

const collectorGroupRefSchema = z.object({ fleetId: uuid, groupId: uuid });

/** openapi.yaml's VariableInUseDetails: at most 100 entries, the totals exact (Q102). */
export const variableInUseDetailsSchema = z.object({
  usedBy: z
    .array(z.object({ publicationId: uuid, groups: z.array(collectorGroupRefSchema).max(100), pinnedCollectors: count }))
    .max(100),
  totalPublications: count,
  totalGroups: count,
  totalPinnedCollectors: count,
});

/** openapi.yaml's VariableGroupInUseDetails: at most 100 collector groups, their total exact. */
export const variableGroupInUseDetailsSchema = z.object({
  collectorGroups: z.array(collectorGroupRefSchema).max(100),
  totalCollectorGroups: count,
  pinnedCollectors: count,
});

/** openapi.yaml's VariablesUndefinedDetails: at most 100 names in byte order, their total exact. */
export const variablesUndefinedDetailsSchema = z.object({ names: z.array(variableName).max(100), totalNames: count });

/**
 * openapi.yaml's error codes, every one of its Error enum (D16a Ruling 58;
 * schemas.test.ts holds the two equal).
 */
export const OPAMP_SERVER_ERROR_CODES = [
  "unauthorized",
  "invalid_request",
  "not_found",
  "organization_not_found",
  "organization_conflict",
  "publication_conflict",
  "payload_too_large",
  "sha256_mismatch",
  "internal_error",
  // D16a: the fleet model's routes (fleets, groups, enrollment tokens,
  // collectors), which the platform calls from D16b on.
  "fleet_not_found",
  "fleet_conflict",
  "fleet_label_taken",
  "fleet_archived",
  "collector_group_not_found",
  "collector_group_name_taken",
  "collector_group_is_default",
  "enrollment_token_not_found",
  "enrollment_token_revoked",
  "enrollment_token_expired",
  // D17c-1 decision 29: a new default token asked for while one is valid.
  "enrollment_token_default_exists",
  "publication_not_found",
  "collector_not_found",
  "collector_name_taken",
  // D16a decision 31, Preflight ruling 17: a delete of a published version a
  // collector group or a collector uses.
  "publication_in_use",
  // D16b Ruling 36: a 503's, for an organization's or a fleet's delete the
  // opamp-server is already running. The client reads no 5xx body: it is
  // `unavailable` (`server_error`), and the organization's delete retries.
  "delete_in_progress",
  // D20 decision 31 (Q101): the organization variables' routes, and the
  // undefined check on an assignment or a pin; the three guards carry a
  // `details` object, which the client parses by its code.
  "variable_not_found",
  "variable_group_not_found",
  "variable_name_taken",
  "variable_group_name_taken",
  "variable_in_use",
  "variable_group_in_use",
  "variables_undefined",
  "variable_limit_reached",
  "variable_group_limit_reached",
  "variable_conflict",
  "variable_group_conflict",
  // 0.2.4's API keys (D36-1 decision 16): a route an API key can't open, and
  // the API key operations' own refusals. The platform authenticates with
  // the management secret and never calls the API key operations, so it
  // never gets one; they are listed because the envelope's enum has them.
  "forbidden",
  "api_key_not_found",
  "api_key_limit_reached",
] as const;

/** openapi.yaml's Error: the envelope every error answers. */
export const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.enum(OPAMP_SERVER_ERROR_CODES), message: z.string() }),
});

export type Organization = z.infer<typeof organizationSchema>;
export type Publication = z.infer<typeof publicationSchema>;
export type PublicationSummary = z.infer<typeof publicationSummarySchema>;
export type PublicationList = z.infer<typeof publicationListSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type FleetType = z.infer<typeof fleetTypeSchema>;
export type FleetStatus = z.infer<typeof fleetStatusSchema>;
export type Fleet = z.infer<typeof fleetSchema>;
export type FleetSummary = z.infer<typeof fleetSummarySchema>;
export type FleetDetail = z.infer<typeof fleetDetailSchema>;
export type FleetList = z.infer<typeof fleetListSchema>;
export type FleetCreated = z.infer<typeof fleetCreatedSchema>;
export type CollectorGroup = z.infer<typeof collectorGroupSchema>;
export type EnrollmentToken = z.infer<typeof enrollmentTokenSchema>;
export type EnrollmentTokenListed = z.infer<typeof enrollmentTokenListSchema>["tokens"][number];
export type EnrollmentTokenRotated = z.infer<typeof enrollmentTokenRotatedSchema>;
export type EnrollmentTokenRevealed = z.infer<typeof enrollmentTokenRevealedSchema>;
export type EnrollmentTokenEventList = z.infer<typeof enrollmentTokenEventListSchema>;
export type CollectorInstancePin = z.infer<typeof collectorInstancePinSchema>;
export type CollectorInstance = z.infer<typeof collectorInstanceSchema>;
export type CollectorInstanceList = z.infer<typeof collectorInstanceListSchema>;
export type CollectorInstanceErrorList = z.infer<typeof collectorInstanceErrorListSchema>;
export type OrganizationLimits = z.infer<typeof organizationLimitsSchema>;
export type ConfigurationUsage = z.infer<typeof configurationUsageSchema>;
export type Variable = z.infer<typeof variableSchema>;
export type VariableGroup = z.infer<typeof variableGroupSchema>;
export type VariableGroupOverride = z.infer<typeof variableGroupOverrideSchema>;
export type VariableGroupDetail = z.infer<typeof variableGroupDetailSchema>;
export type VariableInUseDetails = z.infer<typeof variableInUseDetailsSchema>;
export type VariableGroupInUseDetails = z.infer<typeof variableGroupInUseDetailsSchema>;
export type VariablesUndefinedDetails = z.infer<typeof variablesUndefinedDetailsSchema>;
