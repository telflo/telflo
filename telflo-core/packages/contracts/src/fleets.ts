import { z } from "zod";

/*
 * The platform's fleet routes (D16b decisions 13 to 18; Preflight rulings 5,
 * 8, 9, 12, 15, 16 and 19), under /api/v1/organizations/{organizationId}/fleets:
 * a fleet's list, create, read, update and delete; its enrollment tokens'
 * list, rotation, reveal and revocation; its collector groups, collectors
 * (with their pins and error histories); and, beside the
 * configurations, a configuration's fleet usage. Every member of the
 * organization may use them (decision 6). The opamp-server holds the fleets
 * (D16a); the platform passes them through, its own names on the wire.
 *
 * Published versions are the platform's configuration versions on the wire
 * (decision 14): the browser assigns and pins a configuration version
 * (`assignedVersionId`, `{kind: "version", versionId}`), never a
 * published version's id, and every reply naming a published version's id
 * carries the configuration and version beside it, or null where the
 * platform holds no live version recording it.
 *
 * A bearer (an enrollment token's secret) crosses the platform only in a
 * fleet's create (201), a token's reveal and a rotation, each `no-store`
 * (decision 1). A fleet's label and every bearer are never logged or
 * audited (ADR 0024).
 *
 * The platform's names, and the opamp-server's they map to (D16a's
 * openapi.yaml, which the API's opamp-server client and schemas keep).
 * The platform's say "published version" (the spec's word); a reply's pin
 * is named as a pin's request is, so its `kind` and `versionId` can be
 * sent back. A pin, a resolution and a served state each name a published
 * version only, since D16c removed importing (the `kind` stays, so a later
 * kind can come back without changing what callers send):
 *
 *   platform                                   opamp-server
 *   group.assignedPublishedVersionId           group.assignedPublicationId
 *   collector.pin                              collector.pin
 *     {kind: "version", publishedVersionId,      {kind: "publication", id}
 *      versionId, version}
 *   collector.resolution                       collector.resolution
 *     from "pinnedVersion", publishedVersionId   from "pinnedPublication", id
 *     from "groupVersion", publishedVersionId    from "groupPublication", id
 *   collector.served                           collector.served
 *     {kind: "version", publishedVersionId}      {kind: "publication", id}
 *     {kind: "version", publishedVersionId:      {kind: null, id: null}: the
 *      null}                                     published version deleted
 *   usage.publishedVersions[]                  usage.publications[]
 *     .publishedVersionId                        .id
 *     .recorded {number, label}                  .version {number, label}
 *
 * The platform's own beside them: `version` (`assignedVersion` on a group),
 * the configuration and version the platform holds for that published
 * version (decision 14), or null where it holds no live one.
 */

/** openapi.yaml's bound on a fleet's label: 1 to 80 characters. */
export const FLEET_LABEL_MAXIMUM_LENGTH = 80;

/**
 * openapi.yaml's pattern for a fleet's label (and a group's or a
 * collector's name): no whitespace at either end (Go's unicode.IsSpace) and
 * no control character anywhere (unicode.IsControl). The API's tests hold
 * it equal to the opamp-server client's copy.
 */
export const FLEET_NAME_PATTERN =
  // eslint-disable-next-line no-control-regex -- the contract's own pattern refuses control characters
  /^[^\x00-\x20\x7f-\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]([^\x00-\x1f\x7f-\x9f]*[^\x00-\x20\x7f-\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000])?$/u;

export const FLEET_TYPES = ["server", "kubernetes-supervisor"] as const;
export const FLEET_STATUSES = ["active", "archived"] as const;
export const ENROLLMENT_TOKEN_KINDS = ["default", "rotate"] as const;
/** What a token event records (the opamp-server's enrollment_token_events): made, revealed, put in its grace by a rotation, revoked. */
export const ENROLLMENT_TOKEN_EVENT_KINDS = ["issued", "viewed", "rotated", "revoked"] as const;

export type FleetType = (typeof FLEET_TYPES)[number];
export type FleetStatus = (typeof FLEET_STATUSES)[number];
export type EnrollmentTokenKind = (typeof ENROLLMENT_TOKEN_KINDS)[number];
export type EnrollmentTokenEventKind = (typeof ENROLLMENT_TOKEN_EVENT_KINDS)[number];

/** A page of fleets: the opamp-server's default and its most. */
export const FLEETS_PAGE_DEFAULT_LIMIT = 50;
export const FLEETS_PAGE_MAXIMUM_LIMIT = 100;

/**
 * An opaque cursor of the opamp-server's: a fleet list's is 32 characters,
 * a collector list's sorted by name under 1,200. Anything longer is none of
 * its own.
 */
export const FLEETS_CURSOR_MAXIMUM_LENGTH = 2048;

const uuid = z.string().uuid();

/**
 * A request's time as the opamp-server reads it (management's
 * parseDateTime: Go's RFC 3339, then its offset check): seconds given,
 * then `Z` or an offset `+hh:mm` or `-hh:mm` of at most 23:59. zod's
 * datetime alone takes `09:00Z` (no seconds), `+0530` and `+99:00`, which
 * the opamp-server refuses (400) only after the person's limit is spent:
 * refused here first. It also refuses a time
 * it can't keep (outside the years 0001 to 9999 in UTC), the clock skew
 * case the platform maps to its own 400.
 */
const instantRequest = z
  .string()
  .datetime({ offset: true })
  .regex(/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/, "Invalid datetime");

/** A time in a reply: UTC, ISO 8601. */
const instant = z.string().datetime();

/** A fleet's label: 1 to 80 characters (code points), in FLEET_NAME_PATTERN. Kept as sent, never trimmed. */
export const FleetLabelSchema = z
  .string()
  .refine((value) => {
    const length = [...value].length;
    return length >= 1 && length <= FLEET_LABEL_MAXIMUM_LENGTH;
  }, `Must be 1 to ${FLEET_LABEL_MAXIMUM_LENGTH} characters.`)
  .refine(
    (value) => FLEET_NAME_PATTERN.test(value),
    "Must not start or end with a space, or hold a control character.",
  );

export const FleetTypeSchema = z.enum(FLEET_TYPES);
export const FleetStatusSchema = z.enum(FLEET_STATUSES);

// ---------------------------------------------------------------------------
// Requests.

/**
 * A fleet's create (decision 15): the browser's own id makes a retry safe
 * (the same id, label and type answers 200 with the fleet and no bearer);
 * without one the platform makes one. `rotateExpiresAt` is when the rotate
 * token expires, in the future, or null for never.
 */
export const CreateFleetRequestSchema = z
  .object({
    id: uuid.optional(),
    label: FleetLabelSchema,
    type: FleetTypeSchema,
    rotateExpiresAt: instantRequest.nullable(),
  })
  .strict();

export type CreateFleetRequest = z.infer<typeof CreateFleetRequestSchema>;

/** A fleet's rename or archive: at least one field. */
export const UpdateFleetRequestSchema = z
  .object({
    label: FleetLabelSchema.optional(),
    status: FleetStatusSchema.optional(),
  })
  .strict()
  .refine((value) => value.label !== undefined || value.status !== undefined, "Give a label or a status.");

export type UpdateFleetRequest = z.infer<typeof UpdateFleetRequestSchema>;

/**
 * A rotation of the fleet's rotate token: the new one's expiry (null for
 * never), and when the current one's grace ends (in the future, not after
 * `expiresAt`).
 */
export const RotateEnrollmentTokenRequestSchema = z
  .object({
    expiresAt: instantRequest.nullable(),
    graceEndsAt: instantRequest,
  })
  .strict();

export type RotateEnrollmentTokenRequest = z.infer<typeof RotateEnrollmentTokenRequestSchema>;

/** The fleet list's query: newest first, filtered by status, paged by cursor. */
export const ListFleetsQuerySchema = z
  .object({
    status: FleetStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(FLEETS_PAGE_MAXIMUM_LIMIT).default(FLEETS_PAGE_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(FLEETS_CURSOR_MAXIMUM_LENGTH).optional(),
  })
  .strict();

/** What a client puts in the query string. */
export type ListFleetsQuery = z.input<typeof ListFleetsQuerySchema>;

// ---------------------------------------------------------------------------
// Responses.

/** Who made a fleet or a token: a person, or null for none (the platform always names one). */
export const FleetActorSchema = z.object({ userId: uuid, email: z.string() }).strict();

/**
 * A fleet's rotate tokens at the read (D17a decision 17), or null when none
 * is valid: the current token's expiry (null for never), the latest expiry
 * among the valid tokens in their grace other than the current one (null
 * when none is), and how many rotate tokens are valid.
 */
export const FleetRotateTokenSchema = z
  .object({
    expiresAt: instant.nullable(),
    graceEndsAt: instant.nullable(),
    validCount: z.number().int().min(1),
  })
  .strict();

/**
 * A fleet's collectors, counted by liveness and by drift; the latest time
 * any of them was seen (null with none); its rotate tokens' state.
 */
export const FleetSummarySchema = z
  .object({
    collectors: z.number().int().min(0),
    online: z.number().int().min(0),
    warning: z.number().int().min(0),
    unknown: z.number().int().min(0),
    offline: z.number().int().min(0),
    inSync: z.number().int().min(0),
    pending: z.number().int().min(0),
    failed: z.number().int().min(0),
    drifted: z.number().int().min(0),
    unassigned: z.number().int().min(0),
    lastSeenAt: instant.nullable(),
    rotateToken: FleetRotateTokenSchema.nullable(),
  })
  .strict();

const fleetFields = {
  id: uuid,
  label: z.string(),
  type: FleetTypeSchema,
  status: FleetStatusSchema,
  createdBy: FleetActorSchema.nullable(),
  createdAt: instant,
  updatedAt: instant,
};

/** A fleet, as a create and an update answer it. */
export const FleetSchema = z.object(fleetFields).strict();

/** A fleet as its reads answer it: with its summary. */
export const FleetDetailSchema = z.object({ ...fleetFields, summary: FleetSummarySchema }).strict();

export const FleetResponseSchema = z.object({ fleet: FleetSchema }).strict();
export const FleetDetailResponseSchema = z.object({ fleet: FleetDetailSchema }).strict();

/** One page of the organization's fleets, newest first. */
export const FleetsPageSchema = z
  .object({
    fleets: z.array(FleetDetailSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

/**
 * A published version as the platform knows it (decision 14): its
 * configuration and version, and the collector the version is built for
 * (D17c-1 decision 33: its distribution and version, which an install's
 * image is tagged by), or null where the platform holds no live version
 * recording it.
 */
export const PublishedVersionSchema = z
  .object({
    configurationId: uuid,
    configurationName: z.string(),
    versionId: uuid,
    versionNumber: z.number().int().min(1),
    versionLabel: z.string().nullable(),
    collectorDistribution: z.string(),
    collectorVersion: z.string(),
  })
  .strict();

/**
 * A collector group: its annotations, and the published version assigned it
 * with the platform's names beside it. A Kubernetes group's role, namespace,
 * replicas and volumes are in its annotations (D17d-1 decision 2), which
 * kubernetesOf reads.
 */
export const CollectorGroupSchema = z
  .object({
    id: uuid,
    fleetId: uuid,
    name: z.string(),
    isDefault: z.boolean(),
    /** The group's annotations as the opamp-server returns them (keys sorted), passed through; dockerMountsOf and kubernetesOf read the platform's key. */
    annotations: z.record(z.unknown()).nullable(),
    assignedPublishedVersionId: uuid.nullable(),
    assignedVersion: PublishedVersionSchema.nullable(),
    /** D20: the variable group its collectors' text is filled in with (under a pinned one's overrides), or null. */
    variableGroupId: uuid.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict();

/** A bearer: an enrollment token's secret. Only in the three `no-store` replies; never logged. */
const bearer = z.string().min(1);

/**
 * A fleet's create, 201 (`no-store`): the fleet, its Default group, and both
 * tokens with their bearers, given this once. A retry with the same id,
 * label and type answers 200 FleetResponseSchema (no bearer; a reveal
 * gives one).
 */
export const FleetCreatedResponseSchema = z
  .object({
    fleet: FleetSchema,
    defaultGroup: CollectorGroupSchema,
    tokens: z
      .object({
        default: z.object({ id: uuid, bearer }).strict(),
        rotate: z.object({ id: uuid, bearer, expiresAt: instant.nullable() }).strict(),
      })
      .strict(),
  })
  .strict();

const enrollmentTokenFields = {
  id: uuid,
  fleetId: uuid,
  kind: z.enum(ENROLLMENT_TOKEN_KINDS),
  expiresAt: instant.nullable(),
  revokedAt: instant.nullable(),
  /** Rotated: its collectors are told to move to its successor. */
  doRefresh: z.boolean(),
  createdBy: FleetActorSchema.nullable(),
  createdAt: instant,
};

/** A token without its bearer, as a revoke answers it. */
export const EnrollmentTokenSchema = z.object(enrollmentTokenFields).strict();

/** A token in the fleet's list: without its bearer, with the collectors seen on it in the last 5 minutes. */
export const EnrollmentTokenListedSchema = z
  .object({ ...enrollmentTokenFields, activeCollectors: z.number().int().min(0) })
  .strict();

/** Every token of the fleet, newest first, without a bearer. */
export const EnrollmentTokensResponseSchema = z.object({ tokens: z.array(EnrollmentTokenListedSchema) }).strict();

export const EnrollmentTokenResponseSchema = z.object({ token: EnrollmentTokenSchema }).strict();

/**
 * One event of one of the fleet's tokens (D17b-2 decision 20): ids, who
 * (null for no person) and when; never a bearer or the token's kind (the
 * web pairs the event with the tokens list).
 */
export const EnrollmentTokenEventSchema = z
  .object({
    id: uuid,
    tokenId: uuid,
    event: z.enum(ENROLLMENT_TOKEN_EVENT_KINDS),
    actor: FleetActorSchema.nullable(),
    occurredAt: instant,
  })
  .strict();

/** One page of a fleet's token history, newest first. Not `no-store`: ids, times and members' emails. */
export const EnrollmentTokenEventsPageSchema = z
  .object({ events: z.array(EnrollmentTokenEventSchema), nextCursor: z.string().nullable() })
  .strict();

export type EnrollmentTokenEvent = z.infer<typeof EnrollmentTokenEventSchema>;
export type EnrollmentTokenEventsPage = z.infer<typeof EnrollmentTokenEventsPageSchema>;

/** A rotation (`no-store`): the new rotate token, its bearer, and the token it succeeds (null when none was valid). */
export const EnrollmentTokenRotatedResponseSchema = z
  .object({
    token: z
      .object({ id: uuid, bearer, expiresAt: instant.nullable(), predecessorId: uuid.nullable() })
      .strict(),
  })
  .strict();

/**
 * A reveal (`no-store`): a fresh bearer for the token. A new default token
 * after a revoke (D17c-1 decision 29) answers the same shape.
 */
export const EnrollmentTokenRevealedResponseSchema = z
  .object({
    token: z
      .object({ id: uuid, kind: z.enum(ENROLLMENT_TOKEN_KINDS), bearer, expiresAt: instant.nullable() })
      .strict(),
  })
  .strict();

export type FleetSummary = z.infer<typeof FleetSummarySchema>;
export type FleetRotateToken = z.infer<typeof FleetRotateTokenSchema>;
export type Fleet = z.infer<typeof FleetSchema>;
export type FleetDetail = z.infer<typeof FleetDetailSchema>;
export type FleetResponse = z.infer<typeof FleetResponseSchema>;
export type FleetDetailResponse = z.infer<typeof FleetDetailResponseSchema>;
export type FleetsPage = z.infer<typeof FleetsPageSchema>;
export type FleetActor = z.infer<typeof FleetActorSchema>;
export type PublishedVersion = z.infer<typeof PublishedVersionSchema>;
export type CollectorGroup = z.infer<typeof CollectorGroupSchema>;
export type FleetCreatedResponse = z.infer<typeof FleetCreatedResponseSchema>;
export type EnrollmentToken = z.infer<typeof EnrollmentTokenSchema>;
export type EnrollmentTokenListed = z.infer<typeof EnrollmentTokenListedSchema>;
export type EnrollmentTokensResponse = z.infer<typeof EnrollmentTokensResponseSchema>;
export type EnrollmentTokenResponse = z.infer<typeof EnrollmentTokenResponseSchema>;
export type EnrollmentTokenRotatedResponse = z.infer<typeof EnrollmentTokenRotatedResponseSchema>;
export type EnrollmentTokenRevealedResponse = z.infer<typeof EnrollmentTokenRevealedResponseSchema>;

// ---------------------------------------------------------------------------
// Collector groups, collectors and a configuration's fleet usage
// (D16b Task 4). The bounds are openapi.yaml's, so the platform refuses
// (400, no call) what the opamp-server would.

/** openapi.yaml's bounds on a collector group's name and a collector's: 1 to 80, and 1 to 200 characters. */
export const COLLECTOR_GROUP_NAME_MAXIMUM_LENGTH = 80;
export const COLLECTOR_NAME_MAXIMUM_LENGTH = 200;

/**
 * A group's annotations (D17c-1 decision 30): a JSON object of at most
 * 16,384 bytes both in the opamp-server's canonical form and as Postgres
 * writes it back (ck_collector_groups_annotations_bounded counts
 * `annotations::text`), nesting at most 64 arrays and objects deep (the
 * platform's own bound, stricter than the opamp-server's and Postgres's:
 * a value nested thousands deep, well under 16 KiB, is refused 400 before
 * anything else reads it; the object counting one).
 */
export const COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES = 16_384;
export const COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH = 64;

/** The walks' byte bound: the annotations'. */
const JSON_FIELD_MAXIMUM_BYTES = COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES;

/** A collector list's search text: at most 100 characters. */
export const COLLECTOR_SEARCH_MAXIMUM_LENGTH = 100;

/** A bulk pin's most collectors. */
export const COLLECTOR_PIN_MAXIMUM_COLLECTORS = 500;

export const COLLECTOR_SORTS = ["created", "lastSeen", "name"] as const;
export const COLLECTOR_SORT_ORDERS = ["asc", "desc"] as const;
export const COLLECTOR_LIVENESSES = ["online", "warning", "unknown", "offline"] as const;
export const COLLECTOR_DRIFTS = ["inSync", "pending", "failed", "drifted", "unassigned"] as const;

/** The number of code points of `value`: what openapi.yaml's lengths count. */
function codePointLength(value: string): number {
  return [...value].length;
}

/** A group's or a collector's name: 1 to `maximum` characters (code points), in FLEET_NAME_PATTERN. Kept as sent. */
function displayNameSchema(maximum: number) {
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

export const CollectorGroupNameSchema = displayNameSchema(COLLECTOR_GROUP_NAME_MAXIMUM_LENGTH);
export const CollectorNameSchema = displayNameSchema(COLLECTOR_NAME_MAXIMUM_LENGTH);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The two forms a group's annotations are bounded in: `canonical`, the
 * opamp-server's own (Go's encoding/json with SetEscapeHTML(false): no
 * spaces, as it keeps and answers them), and `jsonb`, Postgres's text of the
 * jsonb it stores (the table's check, octet_length(annotations::text) <=
 * 16384).
 */
type JsonTextForm = "canonical" | "jsonb";

/**
 * The bytes `value` takes as a JSON string in `form`: its quotes, `"` and
 * `\` and \b, \f, \n, \r, \t two bytes, any other C0 control six (\u00XX),
 * a lone surrogate U+FFFD (three), the rest as UTF-8, except U+2028 and
 * U+2029, six in Go's form (escaped) and three in Postgres's (as written).
 * Counted only until past `cap`: a longer text's count is some number above
 * it.
 */
function stringBytes(value: string, form: JsonTextForm, cap: number): number {
  let bytes = 2;
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if ('"\\\b\f\n\r\t'.includes(character)) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code === 0x2028 || code === 0x2029) bytes += form === "canonical" ? 6 : 3;
    else if (LONE_SURROGATE.test(character)) bytes += 3;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
    if (bytes > cap) return bytes;
  }
  return bytes;
}

/**
 * A count of the steps a walk of a group's annotations takes (each value it
 * reads, and each key), which the tests pass to bound a walk's cost by
 * operations (Ruling 37 n5).
 */
export interface JsonWalkSteps {
  count: number;
}

/**
 * The length of a JSON value (a group's annotations) in `form`, or
 * undefined when the opamp-server would refuse it (jsonbKeepsAsWritten): a number written with an
 * exponent, or U+0000 in a string or a key. Each number is as the platform
 * sends it (JSON.stringify's), which both forms keep as written. Keys'
 * order changes neither length. Postgres writes a space after each comma
 * and after each key's colon; Go writes none. Walked with a stack of its
 * own, not by recursion, so no nesting can overflow the call stack (Ruling
 * 25 m1); the sum doesn't depend on the order it is walked in.
 *
 * Counted only until past `limit` (Ruling 37 n5): the walk stops there and
 * answers the count so far, some number above the bound, so a wide value
 * (an object of 200,000 keys, an array of 200,000 items) costs about the
 * bound's steps, each value and key it reads having added at least a byte,
 * though an object's keys are still listed once before its first key's step (V8's
 * for...in), a cost the 1 MiB body limit bounds.
 * At and under the bound the count is exact; past it, an exponent or a
 * U+0000 the walk didn't reach goes unseen (the value is refused either
 * way).
 */
function jsonBytes(root: unknown, form: JsonTextForm, limit: number, steps?: JsonWalkSteps): number | undefined {
  const separator = form === "jsonb" ? 2 : 1;
  const pending: unknown[] = [root];
  let bytes = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (steps !== undefined) steps.count += 1;
    if (value === null) bytes += 4;
    else if (typeof value === "boolean") bytes += value ? 4 : 5;
    else if (typeof value === "number") {
      const text = JSON.stringify(value);
      if (/[eE]/.test(text)) return undefined;
      bytes += text.length;
    } else if (typeof value === "string") {
      if (value.includes("\u0000")) return undefined;
      bytes += stringBytes(value, form, limit - bytes);
    } else if (Array.isArray(value)) {
      // Each item after the first is paid for by its separator before it is read.
      bytes += 2 + Math.max(value.length - 1, 0) * separator;
      if (bytes > limit) return bytes;
      for (const item of value) pending.push(item);
    } else if (typeof value === "object") {
      bytes += 2;
      let first = true;
      // Key by key, stopping once past the bound: V8's for...in still lists an object's keys before its
      // first turn (as Object.keys would), but no entry arrays are built and no further value is read.
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (steps !== undefined) steps.count += 1;
        if (!first) bytes += separator;
        first = false;
        if (key.includes("\u0000")) return undefined;
        bytes += stringBytes(key, form, limit - bytes) + separator;
        if (bytes > limit) return bytes;
        pending.push((value as Record<string, unknown>)[key]);
      }
    } else return undefined;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/**
 * How deep `root` nests arrays and objects (a scalar 0, `[]` 1, `[{}]` 2),
 * counted only up to `limit + 1`: a deeper value is not walked further.
 * Walked with a stack of its own, so no nesting can overflow the call
 * stack.
 *
 * It reads at most 16,385 values (Ruling 37 n5): each value takes at least
 * a byte in either form, so a value holding more is past the byte bound
 * (the annotations' 16,384), which their schema checks next; a wide value (an object of 200,000
 * keys, say) costs about that many steps (its keys still listed once), and
 * its depth is counted only over the values read, so which message a value
 * past both bounds gets depends on where its depth lies; both are true.
 */
export function jsonDepth(root: unknown, limit: number, steps?: JsonWalkSteps): number {
  const pending: [unknown, number][] = [[root, 0]];
  let read = 1;
  let deepest = 0;
  while (pending.length > 0) {
    const [value, above] = pending.pop() as [unknown, number];
    if (steps !== undefined) steps.count += 1;
    if (value === null || typeof value !== "object") continue;
    const depth = above + 1;
    deepest = Math.max(deepest, depth);
    if (depth > limit) return deepest;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (read > JSON_FIELD_MAXIMUM_BYTES) return deepest;
        read += 1;
        pending.push([item, depth]);
      }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (read > JSON_FIELD_MAXIMUM_BYTES) return deepest;
        read += 1;
        pending.push([(value as Record<string, unknown>)[key], depth]);
      }
    }
  }
  return deepest;
}

/**
 * A JSON value's bytes in the opamp-server's canonical form and in
 * Postgres's jsonb text, or undefined when the opamp-server would refuse
 * it. The API's tests hold the second equal to Postgres's own count. Each
 * is exact at and under the 16,384-byte bound, and past it some number
 * above the bound (each walk stops there: Ruling 37 n5).
 */
function jsonTextBytes(value: unknown, steps?: JsonWalkSteps): { canonical: number; jsonb: number } | undefined {
  const canonical = jsonBytes(value, "canonical", JSON_FIELD_MAXIMUM_BYTES, steps);
  const jsonb = jsonBytes(value, "jsonb", JSON_FIELD_MAXIMUM_BYTES, steps);
  return canonical === undefined || jsonb === undefined ? undefined : { canonical, jsonb };
}

/** The annotations' bytes in both forms (jsonTextBytes): the API's tests hold the second equal to Postgres's own count. */
export function annotationsTextBytes(value: unknown, steps?: JsonWalkSteps): { canonical: number; jsonb: number } | undefined {
  return jsonTextBytes(value, steps);
}

/* ---------------------------------------------------------------------------
 * A group's annotations and a server group's mounts (D17c-1 decisions 5, 30
 * and 31; Preflight rulings 6 and 15). The opamp-server stores a group's
 * `annotations` (a JSON object, or null) and returns it unchanged, its keys
 * sorted, and never reads it; the platform keeps its own data under the
 * key "telflo": `{"telflo": {"dockerMounts": [{hostPath, containerPath,
 * readOnly}]}}`, each mount a `-v` line of the group's container install
 * (and, on a Kubernetes fleet's group, `kubernetes`: below). Other keys are
 * another client's, kept as they are. The mounts' rules and their words live
 * here, for the group dialog, the install dialog and the API alike.
 */

/** The annotations' key the platform keeps its data under. */
export const TELFLO_ANNOTATIONS_KEY = "telflo";

/** A server group's most mounts, and a mount path's most characters. */
export const DOCKER_MOUNTS_MAXIMUM = 32;
export const DOCKER_MOUNT_PATH_MAXIMUM_LENGTH = 1024;

/** The collector image's own directory: its entrypoint, its binaries and its volume (/app/opamp). */
export const COLLECTOR_IMAGE_DIRECTORY = "/app";

const MOUNT_PATH_PATTERN = /^\/[A-Za-z0-9._/-]*$/;

/** The message of a container path a group's mounts name twice. */
export const DOCKER_MOUNT_CONTAINER_PATH_TWICE = "Each container path once.";

/**
 * A mount path's problem, or null: an absolute path of at most 1,024
 * characters, of letters, digits, dots, dashes, underscores and `/`, with
 * no `.` or `..` segment (so nothing a shell or Docker reads specially).
 */
export function mountPathProblem(path: string): string | null {
  if (path === "") return "Type a path.";
  if (!path.startsWith("/")) return "Use an absolute path, starting with /.";
  if (path.length > DOCKER_MOUNT_PATH_MAXIMUM_LENGTH) return `At most ${DOCKER_MOUNT_PATH_MAXIMUM_LENGTH.toLocaleString("en-US")} characters.`;
  if (!MOUNT_PATH_PATTERN.test(path)) return "Use letters, digits, dots, dashes, underscores and /.";
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return "Use no . or .. segment.";
  return null;
}

/** A path as Docker reads it: each run of `/` one, and no trailing `/` (but the root's). */
function mountPathAsDockerReadsIt(path: string): string {
  const single = path.replace(/\/+/g, "/");
  return single.length > 1 ? single.replace(/\/$/, "") : single;
}

/**
 * A container path's problem, or null: a mount path, neither the
 * container's root nor the image's own directory or anything under it
 * (Preflight ruling 15).
 */
export function containerPathProblem(path: string): string | null {
  const problem = mountPathProblem(path);
  if (problem !== null) return problem;
  const read = mountPathAsDockerReadsIt(path);
  if (read === "/") return "Use a directory, not the container's root.";
  if (read === COLLECTOR_IMAGE_DIRECTORY || read.startsWith(`${COLLECTOR_IMAGE_DIRECTORY}/`)) {
    return `Use a path outside ${COLLECTOR_IMAGE_DIRECTORY}: the image keeps its own files there.`;
  }
  return null;
}

/** A string `problemOf` finds no problem in, its message the problem's words. */
function checkedText(problemOf: (value: string) => string | null) {
  return z.string().superRefine((value, context) => {
    const problem = problemOf(value);
    if (problem !== null) context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });
}

/** One mount: a host path, a container path, and whether the container reads it only. */
export const DockerMountSchema = z
  .object({
    hostPath: checkedText(mountPathProblem),
    containerPath: checkedText(containerPathProblem),
    readOnly: z.boolean(),
  })
  .strict();

export type DockerMount = z.infer<typeof DockerMountSchema>;

/** A server group's mounts: at most 32, each container path once (as Docker reads it). */
export const DockerMountsSchema = z
  .array(DockerMountSchema)
  .max(DOCKER_MOUNTS_MAXIMUM, `At most ${DOCKER_MOUNTS_MAXIMUM} mounts.`)
  .superRefine((mounts, context) => {
    const seen = new Set<string>();
    for (const [index, mount] of mounts.entries()) {
      const read = mountPathAsDockerReadsIt(mount.containerPath);
      if (seen.has(read)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: DOCKER_MOUNT_CONTAINER_PATH_TWICE, path: [index, "containerPath"] });
      }
      seen.add(read);
    }
  });

/* ---------------------------------------------------------------------------
 * A Kubernetes group's settings (D17d-1 decisions 2, 17 and 18; Preflight
 * rulings 11 and 12). The opamp-server keeps no Kubernetes field: the
 * platform keeps a `kubernetes-supervisor` fleet's group's role, namespace,
 * replicas and hostPath volumes under its annotations' "telflo" key,
 * `{"telflo": {"kubernetes": {role, namespace, replicas?, volumes}}}`, for
 * D17d-2's Helm values. The group's role on screen comes from
 * collectorGroupRole (the fleet's Default group is the Agent, the group
 * named `cluster` the Cluster, any other a gateway pool), never from the
 * stored `role`, which a write sets to it. A namespace, a gateway's name
 * and a volume's paths are configuration text: no message here holds one.
 */

/** A Kubernetes group's roles: the Agent (one collector per node), the Cluster, a gateway pool. */
export const KUBERNETES_ROLES = ["node", "cluster", "gateway"] as const;
export type KubernetesRole = (typeof KUBERNETES_ROLES)[number];

/** The Cluster group's name: at most one per fleet, since a fleet's group names are unique. */
export const COLLECTOR_GROUP_CLUSTER_NAME = "cluster";

/** Names no gateway pool takes: the chart's own releases and the roles. */
export const KUBERNETES_RESERVED_GROUP_NAMES = ["node", "cluster", "telflo-node", "telflo-cluster"] as const;

/** The namespace a group's dialog starts with. */
export const KUBERNETES_DEFAULT_NAMESPACE = "telflo-collectors";

/** A Kubernetes group's namespace: a DNS-1123 label of at most 63 characters. */
export const COLLECTOR_GROUP_NAMESPACE_MAXIMUM_LENGTH = 63;
export const COLLECTOR_GROUP_NAMESPACE_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** A gateway's replicas: 1 to 1,000. */
export const COLLECTOR_GROUP_REPLICAS_MINIMUM = 1;
export const COLLECTOR_GROUP_REPLICAS_MAXIMUM = 1000;

/**
 * A gateway's name (Preflight ruling 12): the platform's chart names the
 * gateway's Service after it
 * (`charts/supervisor-collector/templates/gateway-service.yaml:5`; a
 * DNS-1035 label: it starts with a letter), its Helm release (at most 53)
 * and a StatefulSet whose pods need at most 52 characters after it (D18
 * Q65).
 */
export const KUBERNETES_GATEWAY_NAME_MAXIMUM_LENGTH = 52;
export const KUBERNETES_GATEWAY_NAME_PATTERN = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

/** A hostPath volume's types the group dialog offers (Kubernetes' hostPath types). */
export const KUBERNETES_HOST_PATH_TYPES = ["Directory", "DirectoryOrCreate", "File", "Socket"] as const;
export type KubernetesHostPathType = (typeof KUBERNETES_HOST_PATH_TYPES)[number];

/** A Kubernetes group's most volumes. */
export const KUBERNETES_VOLUMES_MAXIMUM = 32;

/**
 * The node logs the platform's chart mounts into the Agent itself
 * (`charts/supervisor-collector/templates/node-daemonset.yaml:45`, the
 * `varlogpods` mount; its volume at :60-61; D18 Q65).
 */
export const KUBERNETES_AGENT_LOG_PATH = "/var/log/pods";

/** The words of a Kubernetes group's refusals (B's item 17), fixed: none repeats a name, a namespace or a path. */
export const KUBERNETES_VOLUMES_MAXIMUM_MESSAGE = `A group holds at most ${KUBERNETES_VOLUMES_MAXIMUM} volumes.`;
export const KUBERNETES_MOUNT_PATH_TWICE = "Each mount path once.";
export const KUBERNETES_VOLUME_NAME_TWICE = "Two mount paths would name the same volume: change one.";
/**
 * The Agent's volume at the path its chart mounts (Ruling 65): the API's 400
 * details carry it too, where no hint sits above it, so it names the mount
 * itself rather than pointing at the dialog's hint.
 */
export const KUBERNETES_AGENT_LOG_PATH_TAKEN = `The Agent already mounts the node's ${KUBERNETES_AGENT_LOG_PATH} there, for pod logs: mount another path.`;
export const KUBERNETES_REPLICAS_GATEWAY_ONLY = "Replicas are a gateway's only.";
export const KUBERNETES_REPLICAS_MESSAGE = "Use a whole number from 1 to 1,000.";
export const KUBERNETES_HOST_PATH_TYPE_MESSAGE = "Choose Directory, DirectoryOrCreate, File or Socket.";

/** A namespace's problem, or null: a DNS-1123 label of at most 63 characters. */
export function kubernetesNamespaceProblem(namespace: string): string | null {
  if (namespace === "") return "A namespace is required.";
  if (namespace.length > COLLECTOR_GROUP_NAMESPACE_MAXIMUM_LENGTH) {
    return `Namespace must be ${COLLECTOR_GROUP_NAMESPACE_MAXIMUM_LENGTH} characters or fewer.`;
  }
  if (!COLLECTOR_GROUP_NAMESPACE_PATTERN.test(namespace)) {
    return "Use lowercase letters, numbers, and hyphens; must start and end with a letter or number.";
  }
  return null;
}

/**
 * A gateway's name's problem, or null (Preflight ruling 12): a DNS-1035
 * label of at most 52 characters, none of the reserved names. A taken name
 * is the API's to answer (`collector_group_name_taken`).
 */
export function gatewayNameProblem(name: string): string | null {
  if (name === "") return "A gateway name is required.";
  if (name.length > KUBERNETES_GATEWAY_NAME_MAXIMUM_LENGTH) {
    return `Gateway name must be ${KUBERNETES_GATEWAY_NAME_MAXIMUM_LENGTH} characters or fewer.`;
  }
  if ((KUBERNETES_RESERVED_GROUP_NAMES as readonly string[]).includes(name)) {
    return "node, cluster, telflo-node and telflo-cluster are reserved: choose another name.";
  }
  if (!KUBERNETES_GATEWAY_NAME_PATTERN.test(name)) {
    return "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number.";
  }
  return null;
}

/**
 * The name the platform's chart gives a volume mounted at `mountPath`
 * (`charts/supervisor-collector/templates/_helpers.tpl:45`,
 * `tsc.extraVolumeMounts`, and `:53`, `tsc.extraVolumes`, exactly; D18
 * Q65):
 * `printf "extra-%s" (regexReplaceAll "[^a-z0-9]+" (.mountPath | trimPrefix
 * "/" | lower) "-" | trimPrefix "-" | trimSuffix "-") | trunc 63 |
 * trimSuffix "-"`. Two mount paths naming the same volume break the
 * release, so the group refuses them. A mount path is ASCII
 * (mountPathProblem), so lowering it is Go's strings.ToLower.
 */
export function kubernetesVolumeName(mountPath: string): string {
  const slug = mountPath
    .replace(/^\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
  return `extra-${slug}`.slice(0, 63).replace(/-$/, "");
}

/** A namespace: kubernetesNamespaceProblem's rule and words. */
export const CollectorGroupNamespaceSchema = checkedText(kubernetesNamespaceProblem);

/** A gateway's replicas: a whole number from 1 to 1,000. */
export const CollectorGroupReplicasSchema = z
  .number({ invalid_type_error: KUBERNETES_REPLICAS_MESSAGE, required_error: KUBERNETES_REPLICAS_MESSAGE })
  .int(KUBERNETES_REPLICAS_MESSAGE)
  .min(COLLECTOR_GROUP_REPLICAS_MINIMUM, KUBERNETES_REPLICAS_MESSAGE)
  .max(COLLECTOR_GROUP_REPLICAS_MAXIMUM, KUBERNETES_REPLICAS_MESSAGE);

/**
 * One hostPath volume: the node's path, its hostPath type, the path in the
 * collector's container (a container path: not its root, not under the
 * image's /app), and whether the collector reads it only.
 */
export const KubernetesVolumeSchema = z
  .object({
    hostPath: checkedText(mountPathProblem),
    hostPathType: z.enum(KUBERNETES_HOST_PATH_TYPES, { errorMap: () => ({ message: KUBERNETES_HOST_PATH_TYPE_MESSAGE }) }),
    mountPath: checkedText(containerPathProblem),
    readOnly: z.boolean(),
  })
  .strict();

export type KubernetesVolume = z.infer<typeof KubernetesVolumeSchema>;

/**
 * A group's volumes: at most 32, each mount path once (as read: each run of
 * `/` one, no trailing `/`), and no two mount paths naming the same volume
 * in the chart (kubernetesVolumeName). Each problem at its volume's
 * `mountPath`.
 */
export const KubernetesVolumesSchema = z
  .array(KubernetesVolumeSchema)
  .max(KUBERNETES_VOLUMES_MAXIMUM, KUBERNETES_VOLUMES_MAXIMUM_MESSAGE)
  .superRefine((volumes, context) => {
    const paths = new Set<string>();
    const names = new Set<string>();
    for (const [index, volume] of volumes.entries()) {
      const read = mountPathAsDockerReadsIt(volume.mountPath);
      const name = kubernetesVolumeName(volume.mountPath);
      if (paths.has(read)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: KUBERNETES_MOUNT_PATH_TWICE, path: [index, "mountPath"] });
      } else if (names.has(name)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: KUBERNETES_VOLUME_NAME_TWICE, path: [index, "mountPath"] });
      }
      paths.add(read);
      names.add(name);
    }
  });

/**
 * The platform's Kubernetes settings of a group, under its annotations'
 * `telflo.kubernetes`: its role, its namespace, a gateway's replicas (none
 * on the Agent or the Cluster), its volumes (none on the Agent at the path
 * the chart mounts there itself).
 */
export const KubernetesAnnotationsSchema = z
  .object({
    role: z.enum(KUBERNETES_ROLES),
    namespace: CollectorGroupNamespaceSchema,
    replicas: CollectorGroupReplicasSchema.optional(),
    volumes: KubernetesVolumesSchema,
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.replicas !== undefined && settings.role !== "gateway") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: KUBERNETES_REPLICAS_GATEWAY_ONLY, path: ["replicas"] });
    }
    if (settings.role === "node") {
      for (const [index, volume] of settings.volumes.entries()) {
        if (mountPathAsDockerReadsIt(volume.mountPath) === KUBERNETES_AGENT_LOG_PATH) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: KUBERNETES_AGENT_LOG_PATH_TAKEN, path: ["volumes", index, "mountPath"] });
        }
      }
    }
  });

export type KubernetesAnnotations = z.infer<typeof KubernetesAnnotationsSchema>;

/**
 * A group's role on its fleet (Preflight rulings 11 and 24): none on a
 * `server` fleet; on a `kubernetes-supervisor` fleet the Default group is
 * the Agent (`node`), the group named `cluster` the Cluster, any other a
 * gateway pool. Never read from the stored `role`.
 */
export function collectorGroupRole(group: { isDefault: boolean; name: string }, fleetType: FleetType): KubernetesRole | null {
  if (fleetType !== "kubernetes-supervisor") return null;
  if (group.isDefault) return "node";
  return group.name === COLLECTOR_GROUP_CLUSTER_NAME ? "cluster" : "gateway";
}

/**
 * The platform's data under the annotations' "telflo" key, as the platform
 * writes it: a server group's mounts, a Kubernetes group's settings, each
 * optional (D17d-1 decision 17). Which one a group may hold is its fleet
 * type's: the API refuses the other (`kubernetes` on a server fleet's group,
 * `dockerMounts` on a Kubernetes fleet's).
 */
export const TelfloAnnotationsSchema = z
  .object({ dockerMounts: DockerMountsSchema.optional(), kubernetes: KubernetesAnnotationsSchema.optional() })
  .strict();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A group's annotations as the platform writes them: a JSON object nesting
 * at most 64 arrays and objects deep (checked first), at most 16,384 bytes
 * both in the opamp-server's canonical form and in Postgres's jsonb text
 * (near the bound only the opamp-server's Postgres would refuse, a 400 the
 * platform answers 503), with no number the platform would send with an
 * exponent and no U+0000 in a string or a key (the opamp-server refuses
 * each, 400); its "telflo" key, when it has one, the platform's own shape
 * (TelfloAnnotationsSchema), each problem at its path under
 * `telflo.dockerMounts` or `telflo.kubernetes`. A client merges its change
 * into the object it read (annotationsWithDockerMounts,
 * annotationsWithKubernetes) and checks the whole.
 */
export const CollectorGroupAnnotationsSchema = z.record(z.unknown()).superRefine((value, context) => {
  if (jsonDepth(value, COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH) > COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Must nest at most ${COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH} arrays and objects deep.`,
    });
    return;
  }
  const bytes = annotationsTextBytes(value);
  if (
    bytes === undefined ||
    bytes.canonical > COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES ||
    bytes.jsonb > COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Must be at most ${COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES} bytes as JSON, with no number written with an exponent and no U+0000.`,
    });
    return;
  }
  if (Object.hasOwn(value, TELFLO_ANNOTATIONS_KEY)) {
    const telflo = TelfloAnnotationsSchema.safeParse(value[TELFLO_ANNOTATIONS_KEY]);
    if (!telflo.success) {
      for (const issue of telflo.error.issues) context.addIssue({ ...issue, path: [TELFLO_ANNOTATIONS_KEY, ...issue.path] } as z.IssueData);
    }
  }
});

/**
 * A server group's mounts as the platform reads them from its annotations:
 * none when it has none (no annotations, no "telflo" key, no `dockerMounts`);
 * `readable: false` and none when "telflo" holds what the platform can't
 * read (another client's shape, a mount breaking a rule), which a write of
 * the mounts replaces.
 *
 * `readable: true` is a lenient READ: a missing or malformed `readOnly`
 * reads as read-only, `telflo: {}` reads as no mounts, and
 * extra keys (under "telflo" or on a mount) are tolerated and left out. A
 * write always rebuilds "telflo" through annotationsWithDockerMounts, so
 * any unknown key under "telflo" is dropped then.
 *
 * Other clients' keys outside "telflo" are kept, but they round-trip
 * through JSON.parse and JSON.stringify on the platform's write: a number
 * past 2^53 (a 20-digit integer) loses precision, 1e21 or 1e-7 come back
 * with an exponent the schema then refuses, and a top-level "__proto__" key
 * is dropped by z.record. A known limit of the platform's write.
 */
export function dockerMountsOf(annotations: Record<string, unknown> | null | undefined): { readable: boolean; mounts: DockerMount[] } {
  if (annotations === null || annotations === undefined || !Object.hasOwn(annotations, TELFLO_ANNOTATIONS_KEY)) {
    return { readable: true, mounts: [] };
  }
  const telflo = annotations[TELFLO_ANNOTATIONS_KEY];
  if (!isPlainObject(telflo)) return { readable: false, mounts: [] };
  if (!Object.hasOwn(telflo, "dockerMounts")) return { readable: true, mounts: [] };
  const listed = telflo.dockerMounts;
  if (!Array.isArray(listed) || listed.length > DOCKER_MOUNTS_MAXIMUM || !listed.every(isPlainObject)) {
    return { readable: false, mounts: [] };
  }
  const parsed = DockerMountsSchema.safeParse(
    listed.map((mount) => ({
      hostPath: mount.hostPath,
      containerPath: mount.containerPath,
      readOnly: typeof mount.readOnly === "boolean" ? mount.readOnly : true,
    })),
  );
  return parsed.success ? { readable: true, mounts: parsed.data } : { readable: false, mounts: [] };
}

/**
 * The annotations a group write sends for `mounts` (Preflight ruling 30):
 * the object read with its "telflo" key replaced, every other key kept;
 * "telflo" removed when there are no mounts, and null when nothing is
 * left.
 */
export function annotationsWithDockerMounts(
  annotations: Record<string, unknown> | null | undefined,
  mounts: readonly DockerMount[],
): Record<string, unknown> | null {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(annotations ?? {})) if (key !== TELFLO_ANNOTATIONS_KEY) next[key] = value;
  if (mounts.length > 0) next[TELFLO_ANNOTATIONS_KEY] = { dockerMounts: mounts.map(({ hostPath, containerPath, readOnly }) => ({ hostPath, containerPath, readOnly })) };
  return Object.keys(next).length === 0 ? null : next;
}

/**
 * A Kubernetes group's settings as the platform reads them from its
 * annotations (Preflight ruling 11; the web's flag is `kubernetesReadable`,
 * as D17c-1's `mountsReadable`): none when it has none (no annotations, no
 * "telflo" key, no `kubernetes`: the Agent before its first save);
 * `readable: false` and none when "telflo" or its `kubernetes` holds what
 * the platform can't read (another client's shape, a setting breaking a
 * rule), which the next save replaces.
 *
 * `readable: true` is a lenient READ, as dockerMountsOf's: a volume's
 * missing or malformed `readOnly` reads as read-only, a missing
 * `hostPathType` as `Directory` (the chart's default), missing volumes as
 * none, a null `replicas` as none, and extra keys (under "telflo", on the
 * settings or on a volume, such as `type: "hostPath"`) are
 * tolerated and left out; the rest must pass KubernetesAnnotationsSchema
 * (the stored role's rules among them). A write always rebuilds "telflo"
 * through annotationsWithKubernetes.
 */
export function kubernetesOf(annotations: Record<string, unknown> | null | undefined): {
  readable: boolean;
  kubernetes: KubernetesAnnotations | null;
} {
  const none = { readable: true, kubernetes: null };
  const unreadable = { readable: false, kubernetes: null };
  if (annotations === null || annotations === undefined || !Object.hasOwn(annotations, TELFLO_ANNOTATIONS_KEY)) return none;
  const telflo = annotations[TELFLO_ANNOTATIONS_KEY];
  if (!isPlainObject(telflo)) return unreadable;
  if (!Object.hasOwn(telflo, "kubernetes")) return none;
  const stored = telflo.kubernetes;
  if (!isPlainObject(stored)) return unreadable;
  const listed = Object.hasOwn(stored, "volumes") ? stored.volumes : [];
  if (!Array.isArray(listed) || listed.length > KUBERNETES_VOLUMES_MAXIMUM || !listed.every(isPlainObject)) return unreadable;
  const replicas = Object.hasOwn(stored, "replicas") ? stored.replicas : undefined;
  const parsed = KubernetesAnnotationsSchema.safeParse({
    role: stored.role,
    namespace: stored.namespace,
    ...(replicas === undefined || replicas === null ? {} : { replicas }),
    volumes: listed.map((volume) => ({
      hostPath: volume.hostPath,
      hostPathType: Object.hasOwn(volume, "hostPathType") ? volume.hostPathType : "Directory",
      mountPath: volume.mountPath,
      readOnly: typeof volume.readOnly === "boolean" ? volume.readOnly : true,
    })),
  });
  return parsed.success ? { readable: true, kubernetes: parsed.data } : unreadable;
}

/**
 * The annotations a Kubernetes group's write sends for `kubernetes`
 * (Preflight ruling 11): the object read with its "telflo" key rebuilt as
 * `{kubernetes}` only (a stray `dockerMounts` dropped: they are a `docker
 * run`'s), every other key kept, the settings rebuilt from their own fields
 * (Ruling 40's principle: whatever else a caller's object holds is left
 * out); "telflo" removed for none, and null when nothing is left.
 */
export function annotationsWithKubernetes(
  annotations: Record<string, unknown> | null | undefined,
  kubernetes: KubernetesAnnotations | null,
): Record<string, unknown> | null {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(annotations ?? {})) if (key !== TELFLO_ANNOTATIONS_KEY) next[key] = value;
  if (kubernetes !== null) {
    const { role, namespace, replicas, volumes } = kubernetes;
    next[TELFLO_ANNOTATIONS_KEY] = {
      kubernetes: {
        role,
        namespace,
        ...(replicas === undefined ? {} : { replicas }),
        volumes: volumes.map(({ hostPath, hostPathType, mountPath, readOnly }) => ({ hostPath, hostPathType, mountPath, readOnly })),
      },
    };
  }
  return Object.keys(next).length === 0 ? null : next;
}

/**
 * A group's assignment, its annotations and its variable group, each
 * optional; null clears one (the create: unset); an annotations object
 * replaces the group's whole. `assignedVersionId` names a version of a
 * configuration the person can see, which must be published: the platform
 * sends its published copy's id (decision 14). A Kubernetes group's
 * settings are its annotations' `telflo.kubernetes` (D17d-1 decision 2),
 * which the API checks against the fleet's type once it has read it
 * (Preflight ruling 13). `variableGroupId` (D20 decisions 4 and 5) names
 * one of the organization's variable groups, its collectors' text filled
 * in with its overrides first (404 `variable_group_not_found` for one the
 * organization doesn't hold).
 */
const collectorGroupFields = {
  assignedVersionId: uuid.nullable().optional(),
  annotations: CollectorGroupAnnotationsSchema.nullable().optional(),
  variableGroupId: uuid.nullable().optional(),
};

export const CreateCollectorGroupRequestSchema = z
  .object({ name: CollectorGroupNameSchema, ...collectorGroupFields })
  .strict();

export type CreateCollectorGroupRequest = z.infer<typeof CreateCollectorGroupRequestSchema>;

/**
 * A group's rename, assignment, annotations or variable group: at least
 * one field; null clears one (not the name). A Kubernetes fleet's group is never renamed
 * (409 `collector_group_name_fixed`, D17d-1 decision 18).
 */
export const UpdateCollectorGroupRequestSchema = z
  .object({ name: CollectorGroupNameSchema.optional(), ...collectorGroupFields })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Give at least one field.");

export type UpdateCollectorGroupRequest = z.infer<typeof UpdateCollectorGroupRequestSchema>;

/**
 * A collector's pin as the browser sends it (decision 14): a version of a
 * configuration the person can see, which must be published (the platform
 * sends its published copy's id); null unpins. A pin wins over the group's
 * assignment. One kind since D16c (any other, `import` among them, is
 * refused), kept a discriminated union so a kind can come back.
 */
export const CollectorPinRequestSchema = z
  .discriminatedUnion("kind", [z.object({ kind: z.literal("version"), versionId: uuid }).strict()])
  .nullable();

export type CollectorPinRequest = z.infer<typeof CollectorPinRequestSchema>;

/**
 * Pin, or unpin, up to 500 of the fleet's collectors at once, and (D20,
 * Q103) set or clear the variable group pinned on them: at least one of
 * `pin` and `pinnedVariableGroupId`, and a field left out leaves each
 * collector's as it is ("Leave as is"). A null `pin` unpins (each follows
 * its group's version); a null `pinnedVariableGroupId` returns each to its
 * group's variable group.
 */
export const PinCollectorsRequestSchema = z
  .object({
    collectorIds: z.array(uuid).min(1).max(COLLECTOR_PIN_MAXIMUM_COLLECTORS),
    pin: CollectorPinRequestSchema.optional(),
    pinnedVariableGroupId: uuid.nullable().optional(),
  })
  .strict()
  .refine((value) => value.pin !== undefined || value.pinnedVariableGroupId !== undefined, "Give a pin, a variable group, or both.");

export type PinCollectorsRequest = z.infer<typeof PinCollectorsRequestSchema>;

/**
 * A collector's rename, move to another of the fleet's groups, pin or
 * unpin, or (D20 decision 4) the variable group pinned on it, independent
 * of the pin (null returns it to its group's): at least one field.
 */
export const UpdateCollectorRequestSchema = z
  .object({
    name: CollectorNameSchema.optional(),
    groupId: uuid.optional(),
    pin: CollectorPinRequestSchema.optional(),
    pinnedVariableGroupId: uuid.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Give at least one field.");

export type UpdateCollectorRequest = z.infer<typeof UpdateCollectorRequestSchema>;

/** A page's size and cursor: a collector's errors. */
export const FleetsPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(FLEETS_PAGE_MAXIMUM_LIMIT).default(FLEETS_PAGE_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(FLEETS_CURSOR_MAXIMUM_LENGTH).optional(),
  })
  .strict();

export type FleetsPageQuery = z.input<typeof FleetsPageQuerySchema>;

/**
 * The collector list's query: `q` (a name or an address it must contain,
 * ignoring case; never logged), one group's, sorted and ordered, paged by
 * a cursor of the same sort and order.
 */
export const ListCollectorsQuerySchema = z
  .object({
    q: z
      .string()
      .refine(
        (value) => codePointLength(value) <= COLLECTOR_SEARCH_MAXIMUM_LENGTH && !value.includes("\u0000"),
        `Must be at most ${COLLECTOR_SEARCH_MAXIMUM_LENGTH} characters.`,
      )
      .optional(),
    groupId: uuid.optional(),
    sort: z.enum(COLLECTOR_SORTS).optional(),
    order: z.enum(COLLECTOR_SORT_ORDERS).optional(),
    limit: z.coerce.number().int().min(1).max(FLEETS_PAGE_MAXIMUM_LIMIT).default(FLEETS_PAGE_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(FLEETS_CURSOR_MAXIMUM_LENGTH).optional(),
  })
  .strict();

export type ListCollectorsQuery = z.input<typeof ListCollectorsQuerySchema>;

export const CollectorGroupResponseSchema = z.object({ group: CollectorGroupSchema }).strict();

/** Every group of the fleet, the Default group first. */
export const CollectorGroupsResponseSchema = z.object({ groups: z.array(CollectorGroupSchema) }).strict();

/**
 * A collector's pin, named as a pin's request is (so `kind` with
 * `versionId` can be sent back): a published version, its id, the
 * platform's configuration and version beside it, and that version's id
 * (null, with `version`, where the platform holds no live version recording
 * it: an orphan, or a deleted configuration's).
 */
export const CollectorPinSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("version"),
      versionId: uuid.nullable(),
      publishedVersionId: uuid,
      version: PublishedVersionSchema.nullable(),
    })
    .strict(),
]);

/**
 * What resolves for a collector: its pinned published version, else its
 * group's, with the content's hash.
 */
export const CollectorResolutionSchema = z.discriminatedUnion("from", [
  z
    .object({
      from: z.enum(["pinnedVersion", "groupVersion"]),
      publishedVersionId: uuid,
      sha256: z.string(),
      version: PublishedVersionSchema.nullable(),
    })
    .strict(),
]);

/**
 * What a collector was last served, or found already running: a published
 * version, its id null once it is deleted (the opamp-server then names
 * neither its kind nor its id, which its API documents as a deleted
 * published version). `at` is when the collector was last delivered a
 * configuration or, for one found already running those bytes and never
 * delivered one, when it was found so: a retarget to bytes it already runs
 * keeps the earlier delivery's time. Always set, though its type allows
 * null, as the opamp-server's does.
 */
export const CollectorServedSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("version"),
      publishedVersionId: uuid.nullable(),
      sha256: z.string(),
      at: instant.nullable(),
      version: PublishedVersionSchema.nullable(),
    })
    .strict(),
]);

/**
 * A fleet's collector: what resolves for it (its pin, else its group's
 * assignment), what it was last served, its last reported status (its
 * error text the collector's own: shown, never logged) and what it
 * reported of itself; liveness and drift at the opamp-server's clock. Each
 * published version with the platform's names beside it (`version`).
 */
export const CollectorSchema = z
  .object({
    id: uuid,
    instanceUid: uuid,
    name: z.string(),
    fleetId: uuid,
    groupId: uuid,
    pin: CollectorPinSchema.nullable(),
    /** D20: a variable group pinned on it, independent of `pin`: its overrides win over its group's variable group's. Or null. */
    pinnedVariableGroupId: uuid.nullable(),
    resolution: CollectorResolutionSchema.nullable(),
    served: CollectorServedSchema.nullable(),
    effective: z
      .object({
        sha256: z.string(),
        status: z.enum(["applied", "applying", "failed"]),
        error: z.string().nullable(),
        at: instant,
      })
      .strict()
      .nullable(),
    reported: z
      .object({
        collectorVersion: z.string().nullable(),
        ip: z.string().nullable(),
        hostIp: z.string().nullable(),
        attributes: z.record(z.string(), z.string()).nullable(),
      })
      .strict(),
    enrollmentTokenId: uuid.nullable(),
    lastSeenAt: instant,
    liveness: z.enum(COLLECTOR_LIVENESSES),
    drift: z.enum(COLLECTOR_DRIFTS),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict();

export const CollectorResponseSchema = z.object({ collector: CollectorSchema }).strict();

/** One page of the fleet's collectors. */
export const CollectorsPageSchema = z.object({ collectors: z.array(CollectorSchema), nextCursor: z.string().nullable() }).strict();

/** A bulk pin's answer: the fleet's collectors now pinned as asked, and the ids it doesn't hold. */
export const PinCollectorsResponseSchema = z.object({ updated: z.array(uuid), notFound: z.array(uuid) }).strict();

/** One failure a collector reported: its message the collector's own text (shown, never logged). */
export const CollectorErrorSchema = z
  .object({ id: uuid, reportedAt: instant, configSha256: z.string().nullable(), message: z.string() })
  .strict();

/** One page of a collector's error history, newest first. */
export const CollectorErrorsPageSchema = z
  .object({ errors: z.array(CollectorErrorSchema), nextCursor: z.string().nullable() })
  .strict();

/**
 * What uses each of a configuration's published versions (decision 13), by
 * its id (`publishedVersionId`): the collector groups assigned it and how
 * many collectors are pinned to it, with the platform's names beside it
 * (`version`, null where the platform holds no live version recording it)
 * and the version as the opamp-server recorded it when it was published
 * (`recorded`, Ruling 23: kept when `version` is null). `inUse` while any
 * is used. Only for a configuration the person can see.
 */
export const ConfigurationFleetUsageSchema = z
  .object({
    configurationId: uuid,
    inUse: z.boolean(),
    publishedVersions: z.array(
      z
        .object({
          publishedVersionId: uuid,
          publishedAt: instant,
          groups: z.array(z.object({ fleetId: uuid, groupId: uuid }).strict()),
          pinnedCollectors: z.number().int().min(0),
          version: PublishedVersionSchema.nullable(),
          recorded: z.object({ number: z.number().int().min(1), label: z.string().nullable() }).strict(),
        })
        .strict(),
    ),
  })
  .strict();

export const ConfigurationFleetUsageResponseSchema = z.object({ usage: ConfigurationFleetUsageSchema }).strict();

export type CollectorGroupResponse = z.infer<typeof CollectorGroupResponseSchema>;
export type CollectorGroupsResponse = z.infer<typeof CollectorGroupsResponseSchema>;
export type CollectorPin = z.infer<typeof CollectorPinSchema>;
export type CollectorResolution = z.infer<typeof CollectorResolutionSchema>;
export type CollectorServed = z.infer<typeof CollectorServedSchema>;
export type Collector = z.infer<typeof CollectorSchema>;
export type CollectorResponse = z.infer<typeof CollectorResponseSchema>;
export type CollectorsPage = z.infer<typeof CollectorsPageSchema>;
export type PinCollectorsResponse = z.infer<typeof PinCollectorsResponseSchema>;
export type CollectorError = z.infer<typeof CollectorErrorSchema>;
export type CollectorErrorsPage = z.infer<typeof CollectorErrorsPageSchema>;
export type ConfigurationFleetUsage = z.infer<typeof ConfigurationFleetUsageSchema>;
export type ConfigurationFleetUsageResponse = z.infer<typeof ConfigurationFleetUsageResponseSchema>;

// ---------------------------------------------------------------------------
// Refusals.

/**
 * Ruling 19's words, exactly: every failure of the opamp-server's that isn't
 * the person's to fix, 503 `fleets_unavailable`. A write's can follow a
 * change the opamp-server made (a reply lost after its commit), hence
 * "may or may not".
 */
export const FLEETS_UNAVAILABLE_MESSAGE =
  "Fleet management is unavailable right now. A change you were making may or may not have been made: reload before trying again.";

/**
 * Ruling 6's words, exactly: a configuration's delete whose fleet usage
 * couldn't be read, 503 `fleets_unavailable`. The check runs before
 * anything is deleted, so it says so (D16b Task 5).
 */
export const FLEETS_UNAVAILABLE_AT_DELETE_MESSAGE =
  "Couldn't check whether a fleet uses this configuration, so nothing was deleted.";

/**
 * The fleet routes' own codes (Preflight ruling 8). The person's to fix,
 * passed on from the opamp-server: `fleet_conflict`, `fleet_label_taken`,
 * `fleet_archived`, `collector_group_name_taken`,
 * `collector_group_is_default`, `collector_name_taken`,
 * `enrollment_token_revoked`, `enrollment_token_expired`,
 * `enrollment_token_default_exists` (D17c-1 decision 29) (409);
 * `fleet_not_found`, `collector_group_not_found`, `collector_not_found`,
 * `enrollment_token_not_found` (404). `fleets_unavailable` (503) for
 * every other failure; `configuration_version_not_published` (422) for an
 * assignment or a pin naming a version that isn't published. Installing
 * (D17c-1): `collector_group_unassigned`, `collector_group_assignment_deleted`,
 * `collector_version_not_offered`, `fleet_type_not_installable` (409) and
 * `install_unavailable` (503, the templates can't be read). A Kubernetes
 * fleet's group's rename (D17d-1 decision 18): `collector_group_name_fixed`
 * (409, COLLECTOR_GROUP_NAME_FIXED_MESSAGE). A Kubernetes group's Helm
 * install (D17d-2): `collector_group_settings_unreadable` (409,
 * COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE). They also
 * answer the organization's (`organization_not_found`), the
 * configurations' (`configuration_version_not_found`), the session's
 * (`rate_limited`, 429 with Retry-After) and the envelope's
 * (`invalid_request`, 400: a list's cursor or a time the opamp-server
 * refused, or a body the contract refuses).
 */
export const FLEET_ERROR_CODES = [
  "fleet_not_found",
  "fleet_conflict",
  "fleet_label_taken",
  "fleet_archived",
  "collector_group_not_found",
  "collector_group_name_taken",
  "collector_group_is_default",
  "collector_not_found",
  "collector_name_taken",
  "enrollment_token_not_found",
  "enrollment_token_revoked",
  "enrollment_token_expired",
  "enrollment_token_default_exists",
  "fleets_unavailable",
  "configuration_version_not_published",
  // Installing (D17c-1 decisions 36, 38 and 47).
  "install_unavailable",
  "collector_group_unassigned",
  "collector_group_assignment_deleted",
  "collector_version_not_offered",
  "fleet_type_not_installable",
  // Kubernetes groups (D17d-1 decision 18).
  "collector_group_name_fixed",
  // A Kubernetes group's Helm install (D17d-2 decision 15; Preflight ruling 3).
  "collector_group_settings_unreadable",
  // The public install with no group named, on a Kubernetes fleet holding several (D25 decision 37).
  "collector_group_required",
] as const;

export type FleetErrorCode = (typeof FLEET_ERROR_CODES)[number];

/** `collector_group_name_fixed`'s words (D17d-1 decision 18): D17d-2's Helm release is named after the group. */
export const COLLECTOR_GROUP_NAME_FIXED_MESSAGE = "A Kubernetes group's name can't change: its Helm release is named after it.";

/**
 * `collector_group_settings_unreadable`'s words (409; D17d-2 decision 15,
 * Preflight ruling 3): a Kubernetes group's settings the platform can't
 * read (kubernetesOf's `readable: false`, a stored role that isn't the
 * group's, a Cluster or a gateway without settings) refuse its install.
 */
export const COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE = "This group's Kubernetes settings can't be read: save them in Edit first.";
