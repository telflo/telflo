import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import * as schemas from "./schemas.js";

// No zod mirror of openapi.yaml is stricter than the file. A mirror stricter
// than the server's contract makes a documented reply a thrown
// misconfiguration, the route a 503 for good (one long name, one collector
// with an empty error text).
//
// Two halves, both read from the file itself:
// - each mirror parses every fixture here, and each fixture is first
//   checked against the file's own schema with ajv, so it is a reply the
//   server may send;
// - a walk of the file's schema beside the fixtures holds that they reach
//   every limit the file sets, at every place it sets one: each nullable
//   field both null and not, each enum value, each string at its maximum
//   length in code points (with a character Go writes as a 6-byte escape,
//   U+2028, and one of 4 bytes of UTF-8 among them) and at its minimum
//   (the empty string where the file allows one), a string the file leaves
//   unbounded long, each bounded number at both ends and an unbounded one
//   past 2^31, each bounded array at its maximum and empty, an unbounded
//   one longer than any page, a map empty and with many keys. A fixture
//   that stops reaching a limit fails the walk; a mirror that refuses a
//   limit fails the parse.

const OPENAPI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../vendor/opamp-server/openapi.yaml",
);

type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
};

const document = parseYaml(readFileSync(OPENAPI_PATH, "utf8")) as { components: { schemas: Record<string, JsonSchema> } };
const contract = document.components.schemas;

// ---------------------------------------------------------------------------
// The file's schemas, compiled with ajv as the fake compiles them.

const SCHEMAS_ID = "https://opamp-server.telflo.invalid/openapi.yaml";

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      key === "$ref" && typeof value === "string" ? value.replace("#/components/schemas/", `${SCHEMAS_ID}#/$defs/`) : rewriteRefs(value),
    ]),
  );
}

const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
ajv.addFormat("uuid", /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
ajv.addVocabulary(["example"]);
ajv.addSchema({ $id: SCHEMAS_ID, $defs: rewriteRefs(contract) as object });

const compiled = new Map<string, ValidateFunction>();
function validatorOf(name: string): ValidateFunction {
  let validate = compiled.get(name);
  if (validate === undefined) {
    validate = ajv.compile({ $ref: `${SCHEMAS_ID}#/$defs/${name}` });
    compiled.set(name, validate);
  }
  return validate;
}

// ---------------------------------------------------------------------------
// The walk: the limits the file sets, and the ones the fixtures reach.

/** A string the file leaves unbounded is reached "long" at this many code points (past an error text's 8 KiB in prose). */
const LONG_TEXT = 10_000;
/** An array the file leaves unbounded is reached "long" past this many items: longer than any page (100). */
const LONG_ARRAY = 100;
/** A number the file leaves unbounded is reached "huge" from here: past a 32-bit integer. */
const HUGE = 2 ** 31;
/** A map is reached "many" from this many keys. */
const MANY_KEYS = 100;
/** The fixed-shape SHA-256 pattern: no length of its own to reach. */
const SHA256_PATTERN = "^[0-9a-f]{64}$";
/** U+2028, which Go's encoder writes as a 6-byte escape. */
const GO_ESCAPED = "\u2028";
const ASTRAL = /[\u{10000}-\u{10FFFF}]/u;

function deref(node: JsonSchema): JsonSchema {
  if (node.$ref === undefined) return node;
  const name = /^#\/components\/schemas\/(.+)$/.exec(node.$ref)?.[1];
  const target = name === undefined ? undefined : contract[name];
  if (target === undefined) throw new Error(`unsupported $ref ${node.$ref}`);
  return deref(target);
}

function typesOf(node: JsonSchema): string[] {
  if (node.type === undefined) return [];
  return Array.isArray(node.type) ? node.type : [node.type];
}

/** Whether a string schema is free text: no pattern, or one that takes U+2028 and a 4-byte character inside. */
function isFreeText(node: JsonSchema): boolean {
  return node.pattern === undefined || new RegExp(node.pattern, "u").test(`a${GO_ESCAPED}\u{1F680}a`);
}

/** Whether a string schema has no length of its own to reach: a format (uuid, date-time) or the SHA-256's pattern. */
function isFixedShape(node: JsonSchema): boolean {
  return node.format !== undefined || node.pattern === SHA256_PATTERN || node.enum !== undefined;
}

/** Every limit the file sets under `node`, as `path: fact`. */
function limitsOf(rawNode: JsonSchema, path: string): string[] {
  const node = deref(rawNode);
  const types = typesOf(node);
  const facts: string[] = [];
  const at = (fact: string) => facts.push(`${path}: ${fact}`);
  if (types.includes("null")) {
    at("null");
    at("not null");
  }
  if (node.enum !== undefined) for (const value of node.enum) if (value !== null) at(`enum ${JSON.stringify(value)}`);
  if (types.includes("string") && !isFixedShape(node)) {
    const free = isFreeText(node);
    if (node.minLength !== undefined || node.pattern === undefined || new RegExp(node.pattern, "u").test("")) at("shortest");
    if (node.maxLength !== undefined) {
      at("longest");
      if (free) {
        at("longest, with U+2028");
        at("longest, with a 4-byte character");
      }
    } else {
      at("long");
      if (free) {
        at("with U+2028");
        at("with a 4-byte character");
      }
    }
  }
  if (types.includes("integer") || types.includes("number")) {
    if (node.minimum !== undefined) at("minimum");
    at(node.maximum !== undefined ? "maximum" : "huge");
  }
  if (types.includes("boolean")) {
    at("true");
    at("false");
  }
  if (types.includes("array")) {
    at("fewest items");
    at(node.maxItems !== undefined ? "most items" : "many items");
    if (node.items !== undefined) facts.push(...limitsOf(node.items, `${path}[]`));
  }
  if (types.includes("object")) {
    for (const [name, property] of Object.entries(node.properties ?? {})) facts.push(...limitsOf(property, `${path}.${name}`));
    if (typeof node.additionalProperties === "object") {
      at("no keys");
      at("many keys");
      facts.push(...limitsOf({ type: "string" }, `${path}{key}`));
      facts.push(...limitsOf(node.additionalProperties, `${path}{}`));
    }
  }
  return facts;
}

/** The limits `value` reaches under `node`, added to `seen`. */
function reached(rawNode: JsonSchema, value: unknown, path: string, seen: Set<string>): void {
  const node = deref(rawNode);
  const types = typesOf(node);
  const at = (fact: string) => seen.add(`${path}: ${fact}`);
  if (value === null) {
    at("null");
    return;
  }
  if (types.includes("null")) at("not null");
  if (node.enum !== undefined) at(`enum ${JSON.stringify(value)}`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (length === (node.minLength ?? 0)) at("shortest");
    if (node.maxLength !== undefined && length === node.maxLength) {
      at("longest");
      if (value.includes(GO_ESCAPED)) at("longest, with U+2028");
      if (ASTRAL.test(value)) at("longest, with a 4-byte character");
    }
    if (node.maxLength === undefined && length >= LONG_TEXT) at("long");
    if (node.maxLength === undefined && value.includes(GO_ESCAPED)) at("with U+2028");
    if (node.maxLength === undefined && ASTRAL.test(value)) at("with a 4-byte character");
  }
  if (typeof value === "number") {
    if (value === node.minimum) at("minimum");
    if (value === node.maximum) at("maximum");
    if (node.maximum === undefined && value >= HUGE) at("huge");
  }
  if (typeof value === "boolean") at(String(value));
  if (Array.isArray(value)) {
    if (value.length === (node.minItems ?? 0)) at("fewest items");
    if (node.maxItems !== undefined && value.length === node.maxItems) at("most items");
    if (node.maxItems === undefined && value.length > LONG_ARRAY) at("many items");
    if (node.items !== undefined) for (const item of value) reached(node.items, item, `${path}[]`, seen);
  } else if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      if (name in object) reached(property, object[name], `${path}.${name}`, seen);
    }
    if (typeof node.additionalProperties === "object") {
      const keys = Object.keys(object);
      if (keys.length === 0) at("no keys");
      if (keys.length >= MANY_KEYS) at("many keys");
      for (const key of keys) {
        reached({ type: "string" }, key, `${path}{key}`, seen);
        reached(node.additionalProperties, object[key], `${path}{}`, seen);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The fixtures: replies the file allows, at its limits.

const AT = "2026-10-13T09:00:00.000Z";
const SHA = "a".repeat(64);
const id = () => randomUUID();

/**
 * `length` code points: "a", a 4-byte character, U+2028 (which Go writes as
 * a 6-byte escape), then "x"s, and "a" again, so it matches the label and
 * name pattern too (no space or control at either end).
 */
function text(length: number): string {
  if (length < 4) return "abc".slice(0, length);
  return `a\u{1F680}${GO_ESCAPED}${"x".repeat(length - 4)}a`;
}

/** `length` items, cycling through `variants`. */
function cycle<T>(variants: T[], length: number): T[] {
  return Array.from({ length }, (_, index) => variants[index % variants.length] as T);
}

/** At least as many items as the longest of `lists`, each cycled. */
function zipCycled<T extends unknown[][]>(...lists: T): { [K in keyof T]: T[K][number] }[] {
  const length = Math.max(...lists.map((list) => list.length));
  return Array.from({ length }, (_, index) => lists.map((list) => list[index % list.length])) as { [K in keyof T]: T[K][number] }[];
}

const actors = () => [null, { id: id(), email: text(320) }, { id: id(), email: "a" }];
const versions = () => [
  { id: id(), number: 1, label: text(80) },
  { id: id(), number: 2_147_483_647, label: null },
  { id: id(), number: 3, label: "a" },
];
const longBearer = "A".repeat(LONG_TEXT - 2) + "==";
const cursors = () => [text(LONG_TEXT), null, ""];

const configurations = () => [
  { id: id(), name: text(200) },
  { id: id(), name: "a" },
];
const collectors = () => [
  { distribution: "a".repeat(64), version: `1.2.${"3".repeat(60)}` },
  { distribution: "otelcol-contrib", version: "0.162.0" },
];

function publicationSummaries() {
  return zipCycled(actors(), versions(), configurations(), collectors()).map(([publishedBy, version, configuration, collector]) => ({
    id: id(),
    organizationId: id(),
    configuration,
    version,
    sha256: SHA,
    publishedBy,
    publishedAt: AT,
    receivedAt: AT,
    collector,
  }));
}

function publications() {
  return zipCycled(publicationSummaries(), [text(1_048_576), "a"]).map(([summary, yaml]) => ({ ...summary, yaml }));
}

function fleets() {
  return zipCycled(actors(), [text(80), "a"], ["server", "kubernetes-supervisor"], ["active", "archived"]).map(
    ([createdBy, label, type, status]) => ({
      id: id(),
      organizationId: id(),
      label,
      type,
      status,
      createdBy,
      createdAt: AT,
      updatedAt: AT,
    }),
  );
}

const SUMMARY_COUNTS = ["collectors", "online", "warning", "unknown", "offline", "inSync", "pending", "failed", "drifted", "unassigned"];
const rotateTokens = () => [null, { expiresAt: AT, graceEndsAt: null, validCount: 1 }, { expiresAt: null, graceEndsAt: AT, validCount: HUGE }];
const summaries = () =>
  zipCycled([0, HUGE], [null, AT], rotateTokens()).map(([count, lastSeenAt, rotateToken]) => ({
    ...Object.fromEntries(SUMMARY_COUNTS.map((name) => [name, count])),
    lastSeenAt,
    rotateToken,
  }));

function fleetDetails() {
  return zipCycled(fleets(), summaries()).map(([fleet, summary]) => ({ ...fleet, summary }));
}

function groups() {
  return zipCycled(
    [text(80), "a"],
    [true, false],
    [id(), null],
    [
      { "acme.io/owner": "ops", telflo: { dockerMounts: [{ containerPath: "/logs", hostPath: "/var/log", readOnly: true }] } },
      null,
      {},
      // A Kubernetes group's settings are the platform's data in its annotations.
      { telflo: { kubernetes: { namespace: "observability", replicas: 3, role: "gateway", volumes: [] } } },
    ],
    // The variable group its collectors use, or none.
    [null, id()],
  ).map(([name, isDefault, assignedPublicationId, annotations, variableGroupId]) => ({
    id: id(),
    fleetId: id(),
    name,
    isDefault,
    assignedPublicationId,
    annotations,
    variableGroupId,
    createdAt: AT,
    updatedAt: AT,
  }));
}

function tokens() {
  return zipCycled(actors(), ["default", "rotate"], [AT, null], [null, AT], [true, false]).map(
    ([createdBy, kind, expiresAt, revokedAt, doRefresh]) => ({
      id: id(),
      fleetId: id(),
      kind,
      expiresAt,
      revokedAt,
      doRefresh,
      createdBy,
      createdAt: AT,
    }),
  );
}

function tokenEvents() {
  return zipCycled(actors(), ["issued", "viewed", "rotated", "revoked"]).map(([actor, event]) => ({
    id: id(),
    tokenId: id(),
    event,
    actor,
    occurredAt: AT,
  }));
}

function listedTokens() {
  return zipCycled(tokens(), [0, HUGE]).map(([token, activeCollectors]) => ({ ...token, activeCollectors }));
}

/** Attributes as reported: none, and many, keys and values empty, long and in every kind of character. */
function attributeSets() {
  const many = Object.fromEntries(Array.from({ length: MANY_KEYS }, (_, index) => [`key-${index}`, `value-${index}`]));
  return [
    null,
    {},
    { ...many, "": "", [text(LONG_TEXT)]: text(LONG_TEXT) },
  ];
}

function collectorInstances() {
  return zipCycled(
    [text(200), "a"],
    [null, { kind: "publication", id: id() }],
    [null, { from: "pinnedPublication", id: id(), sha256: SHA }, { from: "groupPublication", id: id(), sha256: SHA }],
    [
      null,
      { kind: "publication", id: id(), sha256: SHA, at: AT },
      { kind: "publication", id: id(), sha256: SHA, at: null },
      { kind: null, id: null, sha256: SHA, at: AT },
    ],
    [
      null,
      { sha256: SHA, status: "failed", error: text(LONG_TEXT), at: AT },
      { sha256: SHA, status: "failed", error: "", at: AT },
      { sha256: SHA, status: "applied", error: null, at: AT },
      { sha256: SHA, status: "applying", error: null, at: AT },
    ],
    [
      { collectorVersion: text(LONG_TEXT), ip: "", hostIp: null, attributes: null },
      { collectorVersion: null, ip: text(LONG_TEXT), hostIp: "", attributes: {} },
      { collectorVersion: "", ip: null, hostIp: text(LONG_TEXT), attributes: attributeSets()[2] },
    ],
    [id(), null],
    ["online", "warning", "unknown", "offline"],
    ["inSync", "pending", "failed", "drifted", "unassigned"],
    // A pinned variable group, or none.
    [id(), null],
  ).map(([name, pin, resolution, served, effective, reported, enrollmentTokenId, liveness, drift, pinnedVariableGroupId]) => ({
    id: id(),
    instanceUid: id(),
    name,
    fleetId: id(),
    groupId: id(),
    pin,
    pinnedVariableGroupId,
    resolution,
    served,
    effective,
    reported,
    enrollmentTokenId,
    lastSeenAt: AT,
    liveness,
    sync: drift,
    createdAt: AT,
    updatedAt: AT,
  }));
}

function collectorErrors() {
  return zipCycled([SHA, null], [text(LONG_TEXT), "a"]).map(([configSha256, message]) => ({ id: id(), reportedAt: AT, configSha256, message }));
}

function usagePublications() {
  const groupsOf = (length: number) => Array.from({ length }, () => ({ fleetId: id(), groupId: id() }));
  return zipCycled(versions(), [groupsOf(1_000), [], groupsOf(1)], [0, HUGE]).map(([version, usageGroups, pinnedCollectors]) => ({
    id: id(),
    version,
    publishedAt: AT,
    groups: usageGroups,
    pinnedCollectors,
  }));
}

// The organization variables' mirrors. A value's pattern refuses U+2028 and
// U+2029, so its fixtures leave them out: 1,024 code points with 4-byte
// characters among them, and the empty value. A name is the renderer's
// grammar, ASCII only.

/** A value of `length` code points the value pattern takes: never U+2028 or U+2029. */
function valueText(length: number): string {
  if (length < 2) return "a".slice(0, length);
  return `a\u{1F680}${"x".repeat(length - 2)}`;
}

const variableNames = () => ["_", `A${"_".repeat(127)}`, "otlp_endpoint"];
const values = () => ["", valueText(1024), "a$b"];
const descriptions = () => [null, text(1000), "a"];

function variables() {
  return zipCycled(variableNames(), values(), descriptions(), actors()).map(([name, value, description, changedBy]) => ({
    id: id(),
    name,
    value,
    description,
    changedBy,
    changedAt: AT,
  }));
}

function variableGroups() {
  return zipCycled([text(200), "a"], descriptions(), [0, 150], [0, HUGE], [HUGE, 0], actors()).map(
    ([name, description, overrideCount, collectorGroups, pinnedCollectors, changedBy]) => ({
      id: id(),
      name,
      description,
      overrideCount,
      usage: { collectorGroups, pinnedCollectors },
      changedBy,
      changedAt: AT,
    }),
  );
}

function variableGroupOverrides() {
  return zipCycled(values(), actors()).map(([value, changedBy]) => ({ variableId: id(), value, changedBy, changedAt: AT }));
}

const groupRefs = (length: number) => Array.from({ length }, () => ({ fleetId: id(), groupId: id() }));

function variableInUseDetails() {
  const uses = zipCycled([groupRefs(100), [], groupRefs(1)], [0, HUGE]).map(([groups, pinnedCollectors]) => ({ publicationId: id(), groups, pinnedCollectors }));
  return [
    { usedBy: cycle(uses, 100), totalPublications: HUGE, totalGroups: HUGE, totalPinnedCollectors: HUGE },
    { usedBy: [], totalPublications: 0, totalGroups: 0, totalPinnedCollectors: 0 },
    { usedBy: uses, totalPublications: 3, totalGroups: 101, totalPinnedCollectors: HUGE },
  ];
}

/** Pages: the most items with the longest cursor, none, and one with each other cursor. */
function pages<T>(items: T[], name: string, most: number) {
  return zipCycled([cycle(items, most), [], items.slice(0, 1)], cursors()).map(([page, nextCursor]) => ({ [name]: page, nextCursor }));
}

const ERROR_CODES = (contract.Error?.properties?.error?.properties?.code?.enum ?? []) as string[];

/** Each mirror, the file's schema it mirrors, and its fixtures. */
const MIRRORS: [string, z.ZodTypeAny, () => unknown[]][] = [
  ["OrganizationIdReply", schemas.organizationIdReplySchema, () => [{ organizationId: id() }]],
  ["Organization", schemas.organizationSchema, () => [text(400), "a"].map((name) => ({ organizationId: id(), name, createdAt: AT, updatedAt: AT }))],
  ["Collector", schemas.collectorSchema, collectors],
  ["Publication", schemas.publicationSchema, publications],
  ["PublicationSummary", schemas.publicationSummarySchema, publicationSummaries],
  ["PublicationList", schemas.publicationListSchema, () => pages(publicationSummaries(), "publications", 100)],
  ["FleetType", schemas.fleetTypeSchema, () => ["server", "kubernetes-supervisor"]],
  ["FleetStatus", schemas.fleetStatusSchema, () => ["active", "archived"]],
  ["Fleet", schemas.fleetSchema, fleets],
  ["FleetSummary", schemas.fleetSummarySchema, summaries],
  ["FleetDetail", schemas.fleetDetailSchema, fleetDetails],
  ["FleetList", schemas.fleetListSchema, () => pages(fleetDetails(), "fleets", 100)],
  ["FleetUnchanged", schemas.fleetUnchangedSchema, () => fleets().map((fleet) => ({ fleet }))],
  [
    "FleetCreated",
    schemas.fleetCreatedSchema,
    () =>
      zipCycled(fleets(), groups(), [longBearer, "A"], [AT, null]).map(([fleet, defaultGroup, bearer, expiresAt]) => ({
        fleet,
        defaultGroup,
        tokens: {
          default: { id: id(), bearer },
          rotate: { id: id(), bearer: bearer === "A" ? longBearer : "A", expiresAt },
        },
      })),
  ],
  ["CollectorGroup", schemas.collectorGroupSchema, groups],
  ["CollectorGroupList", schemas.collectorGroupListSchema, () => [{ groups: cycle(groups(), 1_000) }, { groups: [] }]],
  ["EnrollmentToken", schemas.enrollmentTokenSchema, tokens],
  ["EnrollmentTokenList", schemas.enrollmentTokenListSchema, () => [{ tokens: cycle(listedTokens(), 1_000) }, { tokens: [] }]],
  [
    "EnrollmentTokenRotated",
    schemas.enrollmentTokenRotatedSchema,
    () => zipCycled([longBearer, "A"], [AT, null], [id(), null]).map(([bearer, expiresAt, predecessorId]) => ({ id: id(), bearer, expiresAt, predecessorId })),
  ],
  [
    "EnrollmentTokenRevealed",
    schemas.enrollmentTokenRevealedSchema,
    () => zipCycled(["default", "rotate"], [longBearer, "A"], [AT, null]).map(([kind, bearer, expiresAt]) => ({ id: id(), kind, bearer, expiresAt })),
  ],
  ["EnrollmentTokenEventList", schemas.enrollmentTokenEventListSchema, () => pages(tokenEvents(), "events", 100)],
  ["CollectorInstancePin", schemas.collectorInstancePinSchema, () => [null, { kind: "publication", id: id() }]],
  ["CollectorInstance", schemas.collectorInstanceSchema, collectorInstances],
  ["CollectorInstanceList", schemas.collectorInstanceListSchema, () => pages(collectorInstances(), "collectors", 100)],
  [
    "CollectorInstanceBulkPinResult",
    schemas.collectorInstanceBulkPinResultSchema,
    () => [
      { updated: Array.from({ length: 1_000 }, id), notFound: [] },
      { updated: [], notFound: Array.from({ length: 1_000 }, id) },
    ],
  ],
  ["CollectorInstanceErrorList", schemas.collectorInstanceErrorListSchema, () => pages(collectorErrors(), "errors", 100)],
  [
    "OrganizationLimits",
    schemas.organizationLimitsSchema,
    () => zipCycled([0, 2_147_483_647, null], [1, 2_147_483_647, null]).map(([maxCollectors, requestsPerMinute]) => ({ maxCollectors, requestsPerMinute })),
  ],
  [
    "ConfigurationUsage",
    schemas.configurationUsageSchema,
    () => [
      { configurationId: id(), inUse: true, publications: cycle(usagePublications(), 1_000) },
      { configurationId: id(), inUse: false, publications: [] },
      { configurationId: id(), inUse: true, publications: usagePublications() },
    ],
  ],
  ["Variable", schemas.variableSchema, variables],
  ["VariableList", schemas.variableListSchema, () => [{ variables: cycle(variables(), 150) }, { variables: [] }]],
  ["VariableGroup", schemas.variableGroupSchema, variableGroups],
  ["VariableGroupList", schemas.variableGroupListSchema, () => [{ variableGroups: cycle(variableGroups(), 100) }, { variableGroups: [] }]],
  ["VariableGroupOverride", schemas.variableGroupOverrideSchema, variableGroupOverrides],
  [
    "VariableGroupDetail",
    schemas.variableGroupDetailSchema,
    () => zipCycled(variableGroups(), [cycle(variableGroupOverrides(), 150), []]).map(([variableGroup, overrides]) => ({ variableGroup, overrides })),
  ],
  ["VariableInUseDetails", schemas.variableInUseDetailsSchema, variableInUseDetails],
  [
    "VariableGroupInUseDetails",
    schemas.variableGroupInUseDetailsSchema,
    () => [
      { collectorGroups: groupRefs(100), totalCollectorGroups: HUGE, pinnedCollectors: 0 },
      { collectorGroups: [], totalCollectorGroups: 0, pinnedCollectors: HUGE },
    ],
  ],
  [
    "VariablesUndefinedDetails",
    schemas.variablesUndefinedDetailsSchema,
    () => [
      { names: cycle(variableNames(), 100), totalNames: HUGE },
      { names: [], totalNames: 0 },
    ],
  ],
  [
    "Error",
    schemas.errorEnvelopeSchema,
    () => zipCycled(ERROR_CODES, [text(LONG_TEXT), ""]).map(([code, message]) => ({ error: { code, message } })),
  ],
];

/** The zod issues' paths and messages: fixtures hold nothing private. */
function describeIssues(result: z.SafeParseReturnType<unknown, unknown>): string {
  return result.success ? "" : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

describe("no mirror is stricter than openapi.yaml", () => {
  it("covers every schema schemas.ts exports, each against the file's schema of its name", () => {
    const exported = (Object.values(schemas) as unknown[]).filter((value): value is z.ZodTypeAny => value instanceof z.ZodType);
    const mirrored = new Set<z.ZodTypeAny>(MIRRORS.map(([, schema]) => schema));

    expect(exported.filter((schema) => !mirrored.has(schema))).toEqual([]);
    for (const [name] of MIRRORS) expect(contract[name], name).toBeDefined();
  });

  it.each(MIRRORS)("%s parses every fixture, each one a reply the file allows", (name, schema, fixtures) => {
    const validate = validatorOf(name);
    const values = fixtures();

    expect(values.length).toBeGreaterThan(0);
    for (const [index, value] of values.entries()) {
      expect(validate(value), `${name} fixture ${index} against the file: ${ajv.errorsText(validate.errors)}`).toBe(true);
      const result = schema.safeParse(value);
      expect(result.success, `${name} fixture ${index} against its mirror: ${describeIssues(result)}`).toBe(true);
    }
  });

  it.each(MIRRORS)("%s's fixtures reach every limit the file sets", (name, _schema, fixtures) => {
    const root = contract[name] as JsonSchema;
    const seen = new Set<string>();
    for (const value of fixtures()) reached(root, value, name, seen);

    const limits = limitsOf(root, name);
    expect(limits.filter((limit) => !seen.has(limit))).toEqual([]);
  });

  it("reads each limit where the file puts it (spot checks of the walk)", () => {
    const limits = MIRRORS.flatMap(([name]) => limitsOf(contract[name] as JsonSchema, name));

    expect(limits).toEqual(
      expect.arrayContaining([
        "CollectorGroup.annotations: null",
        "CollectorGroup.assignedPublicationId: null",
        "CollectorInstance.effective.error: shortest",
        "CollectorInstance.served.at: null",
        "CollectorInstance.name: longest, with a 4-byte character",
        "CollectorInstance.reported.attributes{key}: long",
        "ConfigurationUsage.publications: many items",
        "ConfigurationUsage.publications[].groups: many items",
        "CollectorGroupList.groups: many items",
        "EnrollmentTokenList.tokens: many items",
        "FleetCreated.tokens.default.bearer: long",
        // The organization variables.
        "Variable.value: shortest",
        "Variable.value: longest",
        "Variable.description: longest, with U+2028",
        "VariableGroup.overrideCount: maximum",
        "VariableInUseDetails.usedBy[].groups: most items",
        "VariablesUndefinedDetails.names[]: longest",
      ]),
    );
    // Fixed shapes have no length to reach.
    expect(limits.filter((limit) => /\.(id|sha256|createdAt): (shortest|longest|long)$/.test(limit))).toEqual([]);
  });
});
