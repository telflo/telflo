import { describe, expect, it } from "vitest";
import { CONFIGURATION_ERROR_CODES } from "./configurations.js";
import {
  annotationsTextBytes,
  annotationsWithDockerMounts,
  annotationsWithKubernetes,
  COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES,
  COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH,
  COLLECTOR_GROUP_NAME_FIXED_MESSAGE,
  COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE,
  CollectorGroupAnnotationsSchema,
  collectorGroupRole,
  CollectorGroupSchema,
  CollectorPinRequestSchema,
  CollectorPinSchema,
  CollectorResolutionSchema,
  CollectorSchema,
  CollectorServedSchema,
  ConfigurationFleetUsageSchema,
  CreateCollectorGroupRequestSchema,
  containerPathProblem,
  CreateFleetRequestSchema,
  DockerMountsSchema,
  dockerMountsOf,
  ENROLLMENT_TOKEN_EVENT_KINDS,
  EnrollmentTokenEventSchema,
  EnrollmentTokenEventsPageSchema,
  EnrollmentTokensResponseSchema,
  FLEET_ERROR_CODES,
  FLEET_LABEL_MAXIMUM_LENGTH,
  FLEET_NAME_PATTERN,
  FLEETS_UNAVAILABLE_AT_DELETE_MESSAGE,
  FLEETS_UNAVAILABLE_MESSAGE,
  FleetCreatedResponseSchema,
  FleetLabelSchema,
  FleetRotateTokenSchema,
  FleetsPageQuerySchema,
  FleetSummarySchema,
  gatewayNameProblem,
  jsonDepth,
  KUBERNETES_RESERVED_GROUP_NAMES,
  KubernetesAnnotationsSchema,
  kubernetesNamespaceProblem,
  kubernetesOf,
  kubernetesVolumeName,
  ListCollectorsQuerySchema,
  ListFleetsQuerySchema,
  mountPathProblem,
  PinCollectorsRequestSchema,
  RotateEnrollmentTokenRequestSchema,
  TelfloAnnotationsSchema,
  UpdateCollectorGroupRequestSchema,
  UpdateCollectorRequestSchema,
  UpdateFleetRequestSchema,
} from "./fleets.js";
import { FLOW_ERROR_CODES } from "./flows.js";
import { IDENTITY_ERROR_CODES } from "./identity.js";
import { ORGANIZATION_ERROR_CODES } from "./organizations.js";
import { SALES_INQUIRY_ERROR_CODES } from "./sales-inquiries.js";
import { OIDC_QUERY_ERROR_CODES, SESSION_ERROR_CODES } from "./sessions.js";
import { TEST_REGEX_ERROR_CODES } from "./test-regexes.js";
import { TESTING_ERROR_CODES } from "./test-runs.js";
import { VALIDATION_RULES_ERROR_CODES } from "./validation-rules.js";

// The fleet routes' contracts (D16b decisions 13 to 18; Preflight rulings 8
// and 19): the codes and the two 503 messages, pinned; each request
// schema's accepted and refused shapes.

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70";
const NOW = "2026-10-13T09:00:00.000Z";

/** Go's unicode.IsSpace, every one: none may start or end a label. */
const GO_SPACES = "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

describe("the codes and the messages", () => {
  it("are Preflight ruling 8's codes, none another module's", () => {
    expect(FLEET_ERROR_CODES).toEqual([
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
      "install_unavailable",
      "collector_group_unassigned",
      "collector_group_assignment_deleted",
      "collector_version_not_offered",
      "fleet_type_not_installable",
      "collector_group_name_fixed",
      "collector_group_settings_unreadable",
      "collector_group_required",
    ]);
    const others = new Set<string>([
      ...CONFIGURATION_ERROR_CODES,
      ...TESTING_ERROR_CODES,
      ...IDENTITY_ERROR_CODES,
      ...ORGANIZATION_ERROR_CODES,
      ...FLOW_ERROR_CODES,
      ...VALIDATION_RULES_ERROR_CODES,
      ...TEST_REGEX_ERROR_CODES,
      ...SESSION_ERROR_CODES,
      ...OIDC_QUERY_ERROR_CODES,
      ...SALES_INQUIRY_ERROR_CODES,
    ]);
    for (const code of FLEET_ERROR_CODES) expect(others.has(code)).toBe(false);
    // Reused, not redeclared: the version's 404 and the person's 429.
    expect(CONFIGURATION_ERROR_CODES).toContain("configuration_version_not_found");
    expect(SESSION_ERROR_CODES).toContain("rate_limited");
  });

  it("are Preflight rulings 6's and 19's words, exactly, and D17d-1 decision 18's for a Kubernetes group's rename", () => {
    expect(COLLECTOR_GROUP_NAME_FIXED_MESSAGE).toBe("A Kubernetes group's name can't change: its Helm release is named after it.");
    // D17d-2 decision 15, Preflight ruling 3: a Kubernetes group's install with settings the platform can't read.
    expect(COLLECTOR_GROUP_SETTINGS_UNREADABLE_MESSAGE).toBe("This group's Kubernetes settings can't be read: save them in Edit first.");
    expect(FLEETS_UNAVAILABLE_MESSAGE).toBe(
      "Fleet management is unavailable right now. A change you were making may or may not have been made: reload before trying again.",
    );
    expect(FLEETS_UNAVAILABLE_AT_DELETE_MESSAGE).toBe(
      "Couldn't check whether a fleet uses this configuration, so nothing was deleted.",
    );
  });
});

describe("a fleet's label (FleetLabelSchema)", () => {
  it("takes 1 to 80 characters, counted as code points, kept as sent", () => {
    expect(FLEET_LABEL_MAXIMUM_LENGTH).toBe(80);
    expect(FleetLabelSchema.parse("edge-prod")).toBe("edge-prod");
    expect(FleetLabelSchema.parse("a".repeat(80))).toBe("a".repeat(80));
    expect(FleetLabelSchema.parse("🚀".repeat(80))).toBe("🚀".repeat(80));
    expect(FleetLabelSchema.parse("edge prodé")).toBe("edge prodé");
    expect(FleetLabelSchema.safeParse("").success).toBe(false);
    expect(FleetLabelSchema.safeParse("a".repeat(81)).success).toBe(false);
  });

  it("refuses Go's spaces at either end and a control character anywhere", () => {
    for (const space of GO_SPACES) {
      expect(FleetLabelSchema.safeParse(`${space}edge`).success).toBe(false);
      expect(FleetLabelSchema.safeParse(`edge${space}`).success).toBe(false);
    }
    for (const control of ["\u0000", "\u0007", "\u001f", "\u007f", "\u0085", "\u009f"]) {
      expect(FleetLabelSchema.safeParse(`ed${control}ge`).success).toBe(false);
    }
    // Inside, a space is a space.
    expect(FLEET_NAME_PATTERN.test("edge\u00a0prod")).toBe(true);
    expect(FLEET_NAME_PATTERN.test("edge\u3000prod")).toBe(true);
  });
});

describe("a fleet's create (CreateFleetRequestSchema)", () => {
  it("takes an optional id, a label, a type and the rotate token's expiry or null", () => {
    expect(CreateFleetRequestSchema.parse({ label: "edge-prod", type: "server", rotateExpiresAt: null })).toEqual({
      label: "edge-prod",
      type: "server",
      rotateExpiresAt: null,
    });
    expect(
      CreateFleetRequestSchema.parse({
        id: ID,
        label: "k8s",
        type: "kubernetes-supervisor",
        rotateExpiresAt: "2026-10-14T09:00:00+02:00",
      }),
    ).toMatchObject({ id: ID, rotateExpiresAt: "2026-10-14T09:00:00+02:00" });
  });

  it.each([
    ["no rotateExpiresAt", { label: "a", type: "server" }],
    ["another type", { label: "a", type: "server-supervisor", rotateExpiresAt: null }],
    ["a malformed id", { id: "42", label: "a", type: "server", rotateExpiresAt: null }],
    ["a time that isn't RFC 3339", { label: "a", type: "server", rotateExpiresAt: "tomorrow" }],
    ["an offset without its colon", { label: "a", type: "server", rotateExpiresAt: "2026-10-14T09:00:00+0530" }],
    ["an offset past 23:59", { label: "a", type: "server", rotateExpiresAt: "2026-10-14T09:00:00+99:00" }],
    ["an unknown field", { label: "a", type: "server", rotateExpiresAt: null, actor: { id: ID, email: "x@y.z" } }],
    ["an organization", { label: "a", type: "server", rotateExpiresAt: null, organizationId: ID }],
  ])("refuses %s", (_label, body) => {
    expect(CreateFleetRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("a fleet's update (UpdateFleetRequestSchema)", () => {
  it("takes a label, a status or both, and refuses neither or an unknown field", () => {
    expect(UpdateFleetRequestSchema.parse({ label: "renamed" })).toEqual({ label: "renamed" });
    expect(UpdateFleetRequestSchema.parse({ status: "archived" })).toEqual({ status: "archived" });
    expect(UpdateFleetRequestSchema.parse({ label: "x", status: "active" })).toEqual({ label: "x", status: "active" });
    expect(UpdateFleetRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateFleetRequestSchema.safeParse({ status: "deleted" }).success).toBe(false);
    expect(UpdateFleetRequestSchema.safeParse({ label: "x", type: "server" }).success).toBe(false);
  });
});

describe("a request's time (Go's RFC 3339, as the opamp-server's parseDateTime reads it)", () => {
  const rotation = (time: string) => RotateEnrollmentTokenRequestSchema.safeParse({ expiresAt: time, graceEndsAt: time }).success;

  it.each([
    "2026-10-14T09:00:00Z",
    "2026-10-14T09:00:00.123Z",
    "2026-10-14T09:00:00.123456789123Z",
    "2026-10-14T09:00:00+00:00",
    "2026-10-14T09:00:00-00:00",
    "2026-10-14T09:00:00+05:30",
    "2026-10-14T09:00:00-23:59",
    "2026-10-14T09:00:00.5+23:59",
  ])("takes %s", (time) => {
    expect(rotation(time)).toBe(true);
    expect(CreateFleetRequestSchema.safeParse({ label: "a", type: "server", rotateExpiresAt: time }).success).toBe(true);
  });

  it.each([
    "2026-10-14T09:00Z",
    "2026-10-14T09:00+05:30",
    "2026-10-14T09:00.5Z",
    "2026-10-14T09:00:00+0530",
    "2026-10-14T09:00:00+05",
    "2026-10-14T09:00:00+99:00",
    "2026-10-14T09:00:00+24:00",
    "2026-10-14T09:00:00+23:60",
    "2026-10-14T09:00:00-0000",
    "2026-10-14T09:00:00",
    "2026-10-14 09:00:00Z",
    "2026-10-14T09:00:00Z ",
  ])("refuses %s", (time) => {
    expect(rotation(time)).toBe(false);
    expect(RotateEnrollmentTokenRequestSchema.safeParse({ expiresAt: null, graceEndsAt: time }).success).toBe(false);
    expect(CreateFleetRequestSchema.safeParse({ label: "a", type: "server", rotateExpiresAt: time }).success).toBe(false);
  });
});

describe("a rotation (RotateEnrollmentTokenRequestSchema)", () => {
  it("takes the new token's expiry or null and the grace's end, both given", () => {
    expect(RotateEnrollmentTokenRequestSchema.parse({ expiresAt: null, graceEndsAt: NOW })).toEqual({
      expiresAt: null,
      graceEndsAt: NOW,
    });
    expect(RotateEnrollmentTokenRequestSchema.safeParse({ graceEndsAt: NOW }).success).toBe(false);
    expect(RotateEnrollmentTokenRequestSchema.safeParse({ expiresAt: null }).success).toBe(false);
    expect(RotateEnrollmentTokenRequestSchema.safeParse({ expiresAt: null, graceEndsAt: NOW, actor: null }).success).toBe(
      false,
    );
  });
});

describe("the fleet list's query (ListFleetsQuerySchema)", () => {
  it("defaults the limit to 50, takes 1 to 100, a status and a cursor; refuses anything else", () => {
    expect(ListFleetsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(ListFleetsQuerySchema.parse({ limit: "100", status: "archived", cursor: "abc" })).toEqual({
      limit: 100,
      status: "archived",
      cursor: "abc",
    });
    for (const query of [{ limit: "0" }, { limit: "101" }, { status: "x" }, { cursor: "" }, { cursor: "x".repeat(2049) }, { q: "edge" }]) {
      expect(ListFleetsQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe("the replies", () => {
  it("carry a bearer only in a create's tokens; the token list has none", () => {
    const token = {
      id: ID,
      fleetId: ID,
      kind: "default",
      expiresAt: null,
      revokedAt: null,
      doRefresh: false,
      createdBy: { userId: ID, email: "sam@acme.io" },
      createdAt: NOW,
      activeCollectors: 0,
    };
    expect(EnrollmentTokensResponseSchema.parse({ tokens: [token] })).toEqual({ tokens: [token] });
    expect(EnrollmentTokensResponseSchema.safeParse({ tokens: [{ ...token, bearer: "c2VjcmV0" }] }).success).toBe(false);
    expect(FleetCreatedResponseSchema.shape.tokens.shape.default.shape).toHaveProperty("bearer");
  });

  it("carry a fleet's last seen and its rotate token's state in its summary, each required, null or set (D17a decision 17)", () => {
    const counts = {
      collectors: 1,
      online: 1,
      warning: 0,
      unknown: 0,
      offline: 0,
      inSync: 0,
      pending: 0,
      failed: 0,
      drifted: 0,
      unassigned: 1,
    };
    const rotating = { expiresAt: null, graceEndsAt: NOW, validCount: 2 };
    for (const summary of [
      { ...counts, lastSeenAt: NOW, rotateToken: { expiresAt: NOW, graceEndsAt: null, validCount: 1 } },
      { ...counts, lastSeenAt: null, rotateToken: rotating },
      { ...counts, lastSeenAt: null, rotateToken: null },
    ]) {
      expect(FleetSummarySchema.parse(summary)).toEqual(summary);
    }
    const { lastSeenAt: _lastSeenAt, ...withoutLastSeen } = { ...counts, lastSeenAt: null, rotateToken: null };
    const { rotateToken: _rotateToken, ...withoutRotateToken } = { ...counts, lastSeenAt: null, rotateToken: null };
    expect(FleetSummarySchema.safeParse(withoutLastSeen).success).toBe(false);
    expect(FleetSummarySchema.safeParse(withoutRotateToken).success).toBe(false);
    expect(FleetSummarySchema.safeParse({ ...counts, lastSeenAt: "yesterday", rotateToken: null }).success).toBe(false);
    expect(FleetRotateTokenSchema.safeParse({ ...rotating, validCount: 0 }).success).toBe(false);
    expect(FleetRotateTokenSchema.safeParse({ ...rotating, validCount: 1.5 }).success).toBe(false);
    expect(FleetRotateTokenSchema.safeParse({ ...rotating, current: true }).success).toBe(false);
    expect(FleetRotateTokenSchema.safeParse({ expiresAt: null, validCount: 1 }).success).toBe(false);
  });

  it("carry a token event's ids, kind, actor ({userId, email} or null) and time, never a bearer or the token's kind; a page its events and next cursor (D17b-2 decision 20)", () => {
    expect(ENROLLMENT_TOKEN_EVENT_KINDS).toEqual(["issued", "viewed", "rotated", "revoked"]);
    const event = { id: ID, tokenId: ID, event: "viewed", actor: { userId: ID, email: "sam@acme.io" }, occurredAt: NOW };
    for (const kind of ENROLLMENT_TOKEN_EVENT_KINDS) {
      expect(EnrollmentTokenEventSchema.parse({ ...event, event: kind })).toEqual({ ...event, event: kind });
    }
    expect(EnrollmentTokenEventSchema.parse({ ...event, actor: null })).toEqual({ ...event, actor: null });
    const { actor: _actor, ...withoutActor } = event;
    for (const refused of [
      { ...event, event: "created" },
      { ...event, bearer: "c2VjcmV0" },
      { ...event, kind: "default" },
      { ...event, actor: { id: ID, email: "sam@acme.io" } },
      { ...event, actor: { userId: ID, email: "sam@acme.io", name: "Sam" } },
      { ...event, tokenId: "x" },
      { ...event, occurredAt: "yesterday" },
      withoutActor,
    ]) {
      expect(EnrollmentTokenEventSchema.safeParse(refused).success).toBe(false);
    }

    for (const page of [
      { events: [event, { ...event, event: "issued", actor: null }], nextCursor: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { events: [], nextCursor: null },
    ]) {
      expect(EnrollmentTokenEventsPageSchema.parse(page)).toEqual(page);
    }
    expect(EnrollmentTokenEventsPageSchema.safeParse({ events: [] }).success).toBe(false);
    expect(EnrollmentTokenEventsPageSchema.safeParse({ events: [], nextCursor: null, tokens: [] }).success).toBe(false);
    expect(EnrollmentTokenEventsPageSchema.safeParse({ events: [{ ...event, bearer: "c2VjcmV0" }], nextCursor: null }).success).toBe(false);
  });
});

// D16b Task 4: collector groups, collectors and a configuration's fleet
// usage. Published versions are configuration versions on the wire
// (decision 14); the bounds are openapi.yaml's.

describe("a collector group's create and update", () => {
  it("takes a name, a configuration version to assign (or null) and annotations, each optional", () => {
    expect(CreateCollectorGroupRequestSchema.parse({ name: "gateways" })).toEqual({ name: "gateways" });
    const full = { name: "g".repeat(80), assignedVersionId: ID, annotations: { telflo: { kubernetes: { role: "gateway", namespace: "a".repeat(63), replicas: 1000, volumes: [] } } } };
    expect(CreateCollectorGroupRequestSchema.parse(full)).toEqual(full);
    const cleared = { name: "x", assignedVersionId: null, annotations: null };
    expect(CreateCollectorGroupRequestSchema.parse(cleared)).toEqual(cleared);
    expect(UpdateCollectorGroupRequestSchema.parse({ assignedVersionId: null })).toEqual({ assignedVersionId: null });
    // D17c-1 decision 30: annotations, an object (another client's keys kept as sent) or null.
    const annotations = { telflo: { dockerMounts: [{ hostPath: "/var/log", containerPath: "/logs", readOnly: true }] }, "acme.io/x": [1, { a: null }] };
    expect(CreateCollectorGroupRequestSchema.parse({ name: "x", annotations })).toEqual({ name: "x", annotations });
    expect(UpdateCollectorGroupRequestSchema.parse({ annotations })).toEqual({ annotations });
    expect(UpdateCollectorGroupRequestSchema.parse({ annotations: null })).toEqual({ annotations: null });
    expect(UpdateCollectorGroupRequestSchema.parse({ annotations: {} })).toEqual({ annotations: {} });
  });

  it("takes a variable group's id, or null for none, on the create and the update alone (D20 decisions 4 and 5)", () => {
    expect(CreateCollectorGroupRequestSchema.parse({ name: "x", variableGroupId: ID })).toEqual({ name: "x", variableGroupId: ID });
    expect(CreateCollectorGroupRequestSchema.parse({ name: "x", variableGroupId: null })).toEqual({ name: "x", variableGroupId: null });
    expect(UpdateCollectorGroupRequestSchema.parse({ variableGroupId: ID })).toEqual({ variableGroupId: ID });
    expect(UpdateCollectorGroupRequestSchema.parse({ variableGroupId: null })).toEqual({ variableGroupId: null });
    for (const refused of ["42", "", "theirs"]) {
      expect(CreateCollectorGroupRequestSchema.safeParse({ name: "x", variableGroupId: refused }).success).toBe(false);
      expect(UpdateCollectorGroupRequestSchema.safeParse({ variableGroupId: refused }).success).toBe(false);
    }
  });

  it.each([
    ["no name", {}],
    ["a name of 81 characters", { name: "a".repeat(81) }],
    ["a name with an edge space", { name: "edge " }],
    ["a publication id (never the browser's)", { name: "x", assignedPublicationId: ID }],
    ["a malformed version id", { name: "x", assignedVersionId: "42" }],
    // D17d-1 decision 2: the opamp-server's four Kubernetes fields are gone; they live in the annotations.
    ["a role", { name: "x", role: "gateway" }],
    ["a namespace", { name: "x", namespace: "telemetry" }],
    ["replicas", { name: "x", replicas: 1 }],
    ["volumes", { name: "x", volumes: [] }],
    ["a null Kubernetes field", { name: "x", role: null }],
    ["annotations whose Kubernetes settings break a rule", { name: "x", annotations: { telflo: { kubernetes: { role: "gateway", namespace: "-telemetry", volumes: [] } } } }],
    ["annotations that are an array", { name: "x", annotations: [] }],
    ["annotations that are a string", { name: "x", annotations: "telflo" }],
    ["annotations whose telflo key isn't the platform's shape", { name: "x", annotations: { telflo: { mounts: [] } } }],
    ["an organization", { name: "x", organizationId: ID }],
  ])("refuses a create with %s", (_label, body) => {
    expect(CreateCollectorGroupRequestSchema.safeParse(body).success).toBe(false);
  });

  it("refuses an empty update, a null name and an unknown field, the four Kubernetes fields among them", () => {
    expect(UpdateCollectorGroupRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateCollectorGroupRequestSchema.safeParse({ name: null }).success).toBe(false);
    expect(UpdateCollectorGroupRequestSchema.safeParse({ isDefault: true }).success).toBe(false);
    for (const field of ["role", "namespace", "replicas", "volumes"]) {
      expect(UpdateCollectorGroupRequestSchema.safeParse({ [field]: null }).success).toBe(false);
    }
  });
});

// The walks the annotations' bounds use (D17c-1 decision 30; Rulings 23,
// 25 m1 and 37 n5), once the volumes' (D16b) before D17d-1 moved a
// Kubernetes group's volumes into the annotations.
describe("the annotations' walks (annotationsTextBytes, jsonDepth)", () => {
  /** `{"n":"..."}`: 8 bytes around the text in the opamp-server's form, 9 in Postgres's (`{"n": "..."}`). */
  const annotationsOf = (text: string) => ({ n: text });
  const takes = (value: unknown) => CollectorGroupAnnotationsSchema.safeParse(value).success;

  it("counts both forms: the opamp-server's (no spaces, U+2028 escaped) and Postgres's jsonb text (a space after each comma and colon, U+2028 as written)", () => {
    expect(annotationsTextBytes([{ n: "abc" }])).toEqual({ canonical: 13, jsonb: 14 });
    expect(annotationsTextBytes([{}, {}, {}])).toEqual({ canonical: 10, jsonb: 12 });
    expect(annotationsTextBytes(["a\u2028b"])).toEqual({ canonical: 12, jsonb: 9 });
    expect(annotationsTextBytes([[1, 2], { b: [3, { c: null }], a: true }])).toEqual({ canonical: 37, jsonb: 44 });
    expect(annotationsTextBytes([{ n: "a\u0000b" }])).toBeUndefined();
    expect(annotationsTextBytes([{ size: 1e21 }])).toBeUndefined();
  });

  it("takes at most 16,384 bytes in Postgres's form: a plain text, a 4-byte character four, a quote two", () => {
    expect(takes(annotationsOf("a".repeat(16_375)))).toBe(true);
    // 16,384 bytes in the opamp-server's form, 16,385 in Postgres's: its table would refuse it.
    expect(annotationsTextBytes(annotationsOf("a".repeat(16_376)))).toEqual({ canonical: 16_384, jsonb: 16_385 });
    expect(takes(annotationsOf("a".repeat(16_376)))).toBe(false);
    expect(takes(annotationsOf(`${"a".repeat(16_371)}\u{1F680}`))).toBe(true);
    expect(takes(annotationsOf(`${"a".repeat(16_372)}\u{1F680}`))).toBe(false);
    expect(takes(annotationsOf(`${"a".repeat(16_373)}"`))).toBe(true);
    expect(takes(annotationsOf(`${"a".repeat(16_374)}"`))).toBe(false);
  });

  it("takes at most 16,384 bytes in the opamp-server's form: U+2028 six there, three in Postgres's", () => {
    expect(takes(annotationsOf(`${"a".repeat(16_370)}\u2028`))).toBe(true);
    expect(annotationsTextBytes(annotationsOf(`${"a".repeat(16_371)}\u2028`))).toEqual({ canonical: 16_385, jsonb: 16_383 });
    expect(takes(annotationsOf(`${"a".repeat(16_371)}\u2028`))).toBe(false);
  });

  it("counts Postgres's space after each item's comma: 32 items at the bound", () => {
    const items = (last: number) => ({ n: [...Array.from({ length: 31 }, () => "a".repeat(508)), "a".repeat(last)] });
    expect(annotationsTextBytes(items(501))).toEqual({ canonical: 16_352, jsonb: 16_384 });
    expect(takes(items(501))).toBe(true);
    expect(annotationsTextBytes(items(502))).toEqual({ canonical: 16_353, jsonb: 16_385 });
    expect(takes(items(502))).toBe(false);
  });

  it("refuses a number the platform would send with an exponent, and U+0000 in a string or a key; takes -0 (sent as 0)", () => {
    expect(takes({ v: [{ size: 1e20, ratio: 0.5, negative: -0 }] })).toBe(true);
    expect(takes({ v: [{ size: 1e21 }] })).toBe(false);
    expect(takes({ v: [{ size: 1e-7 }] })).toBe(false);
    expect(takes({ v: [{ name: "a\u0000b" }] })).toBe(false);
    expect(takes({ v: [{ "a\u0000b": "c" }] })).toBe(false);
    expect(takes({ v: [["nested", [null, true, false, 1.5]]] })).toBe(true);
  });

  /** An array holding `depth - 1` more containers, arrays and objects in turn: `depth` deep. */
  const nested = (depth: number): unknown[] => {
    let value: unknown = "leaf";
    for (let level = depth - 1; level >= 1; level--) value = level % 2 === 0 ? [value] : { v: value };
    return [value];
  };

  it("counts nesting by arrays and objects, the outermost one", () => {
    expect(jsonDepth("x", COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH)).toBe(0);
    expect(jsonDepth([], COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH)).toBe(1);
    expect(jsonDepth([{}], COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH)).toBe(2);
    expect(jsonDepth([1, { a: [[]] }, "b"], COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH)).toBe(4);
    expect(jsonDepth(nested(64), COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH)).toBe(64);
    expect(jsonDepth(nested(65), COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH)).toBe(65);
  });

  it("refuses a value nested far deeper without overflowing the stack, and counts its bytes without overflowing it", () => {
    // 5,000 arrays deep is 10,000 bytes, under the byte bound: only the depth refuses it.
    let arrays: unknown = [];
    for (let level = 1; level < 5_000; level++) arrays = [arrays];
    expect(annotationsTextBytes(arrays)).toEqual({ canonical: 10_000, jsonb: 10_000 });
    const refused = CollectorGroupAnnotationsSchema.safeParse({ v: arrays });
    expect(refused.error?.issues.map((issue) => issue.message)).toEqual(["Must nest at most 64 arrays and objects deep."]);
    for (const depth of [10_000, 200_000]) {
      const deep = nested(depth);
      expect(() => CollectorGroupAnnotationsSchema.safeParse({ v: deep })).not.toThrow();
      expect(CollectorGroupAnnotationsSchema.safeParse({ v: deep }).success).toBe(false);
      // The byte count stops once past the bound (Ruling 37 n5), each level at least 2 bytes.
      const steps = { count: 0 };
      const bytes = annotationsTextBytes(deep, steps);
      expect(bytes?.canonical).toBeGreaterThan(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
      expect(bytes?.jsonb).toBeGreaterThan(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
      expect(steps.count).toBeLessThanOrEqual(2 * (COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES + 1));
    }
  });

  describe("a very wide value: each walk stops once past its bound (Ruling 37 n5)", () => {
    /** At most the bound's steps per walk, plus one: each value and key read adds at least a byte. */
    const MOST_STEPS = 2 * (COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES + 1);
    const WIDE: [string, Record<string, unknown>][] = [
      ["an object of 200,000 keys", Object.fromEntries(Array.from({ length: 200_000 }, (_, index) => [`k${index}`, index]))],
      ["an object of 200,000 short keys, each an empty object", Object.fromEntries(Array.from({ length: 200_000 }, (_, index) => [index.toString(36), {}]))],
      ["an array of 200,000 items", { v: Array.from({ length: 200_000 }, () => 0) }],
      ["32 arrays of 6,250 items", { v: Array.from({ length: 32 }, () => Array.from({ length: 6_250 }, () => [0])) }],
    ];

    it.each(WIDE)("refuses %s by its bytes", (_label, value) => {
      const refused = CollectorGroupAnnotationsSchema.safeParse(value);
      expect(refused.success).toBe(false);
      expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
        "Must be at most 16384 bytes as JSON, with no number written with an exponent and no U+0000.",
      ]);
    });

    it.each(WIDE)("walks %s in a bounded number of steps", (_label, value) => {
      const depthSteps = { count: 0 };
      expect(jsonDepth(value, COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH, depthSteps)).toBeLessThanOrEqual(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH);
      expect(depthSteps.count).toBeLessThanOrEqual(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES + 1);
      const bytesSteps = { count: 0 };
      const bytes = annotationsTextBytes(value, bytesSteps);
      expect(bytes?.canonical).toBeGreaterThan(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
      expect(bytes?.jsonb).toBeGreaterThan(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
      expect(bytesSteps.count).toBeLessThanOrEqual(2 * MOST_STEPS);
    });

    it("walks a value at the bound whole: its depth and both counts exact", () => {
      // 16,384 bytes in Postgres's form: `{"v": [0, 0, ..., 1000]}`, 5,458 items, each after the first 3 bytes there.
      const value = { v: [...Array.from({ length: 5_457 }, () => 0), 1000] };
      const depthSteps = { count: 0 };
      expect(jsonDepth(value, COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_DEPTH, depthSteps)).toBe(2);
      expect(depthSteps.count).toBe(5_460);
      const bytesSteps = { count: 0 };
      expect(annotationsTextBytes(value, bytesSteps)).toEqual({ canonical: 10_926, jsonb: 16_384 });
      expect(bytesSteps.count).toBe(2 * 5_461);
      expect(takes(value)).toBe(true);
    });
  });
});

describe("a group's annotations (CollectorGroupAnnotationsSchema, D17c-1 decision 30)", () => {
  /** An object of one key whose string value makes its canonical text `bytes` long ({"a":"…"}: 8 more). */
  const ofCanonicalBytes = (bytes: number) => ({ a: "v".repeat(bytes - 8) });

  it("takes an object at the bound in both forms, and refuses one a byte over in either", () => {
    expect(annotationsTextBytes(ofCanonicalBytes(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES))).toEqual({
      canonical: COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES,
      jsonb: COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES + 1,
    });
    // jsonb's text has a space after the colon: its bound is the one met first here.
    expect(CollectorGroupAnnotationsSchema.safeParse(ofCanonicalBytes(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES - 1)).success).toBe(true);
    expect(CollectorGroupAnnotationsSchema.safeParse(ofCanonicalBytes(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES)).success).toBe(false);
    // Many keys: jsonb's spaces after each comma and colon take it over first.
    const keys = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`k${String(index).padStart(2, "0")}`, "v".repeat(502)]));
    // jsonb's text would be 16,416 bytes; the walk stops a little past the bound.
    expect(annotationsTextBytes(keys)?.canonical).toBe(16_353);
    expect(annotationsTextBytes(keys)?.jsonb).toBeGreaterThan(COLLECTOR_GROUP_ANNOTATIONS_MAXIMUM_BYTES);
    expect(CollectorGroupAnnotationsSchema.safeParse(keys).success).toBe(false);
  });

  it("refuses what the opamp-server would refuse, and nesting past 64 deep, with their messages", () => {
    // The annotations' own object counts one: 65 objects deep is past the bound.
    let deep: unknown = "leaf";
    for (let level = 0; level < 65; level++) deep = { d: deep };
    const refusals: [unknown, string][] = [
      [{ n: 1e21 }, "bytes as JSON"],
      [{ s: "a\u0000b" }, "bytes as JSON"],
      [{ "a\u0000": 1 }, "bytes as JSON"],
      [deep, "64 arrays and objects deep"],
    ];
    for (const [value, words] of refusals) {
      const parsed = CollectorGroupAnnotationsSchema.safeParse(value);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain(words);
    }
    let atDepth: unknown = [];
    for (let level = 0; level < 63; level++) atDepth = { d: atDepth };
    expect(CollectorGroupAnnotationsSchema.safeParse(atDepth).success).toBe(true);
    expect(CollectorGroupAnnotationsSchema.safeParse({ top: atDepth }).success).toBe(false);
    for (const refused of [[], "x", 1, null, true]) expect(CollectorGroupAnnotationsSchema.safeParse(refused).success).toBe(false);
  });

  it("checks its telflo key as the platform's own shape, each problem at its path; other keys are another client's", () => {
    const mount = { hostPath: "/var/log", containerPath: "/logs", readOnly: false };
    expect(CollectorGroupAnnotationsSchema.safeParse({ telflo: { dockerMounts: [mount] }, other: { telflo: 1 } }).success).toBe(true);
    // D17d-1 decision 17: each of the platform's keys optional, so an empty one too.
    expect(CollectorGroupAnnotationsSchema.safeParse({ telflo: {} }).success).toBe(true);
    expect(CollectorGroupAnnotationsSchema.safeParse({ other: { mounts: "anything" } }).success).toBe(true);
    const issues = (value: unknown) => CollectorGroupAnnotationsSchema.safeParse(value).error?.issues.map((issue) => [issue.path.join("."), issue.message]);
    expect(issues({ telflo: { dockerMounts: [{ ...mount, hostPath: "var/log" }, { ...mount, containerPath: "/app/x" }] } })).toEqual([
      ["telflo.dockerMounts.0.hostPath", "Use an absolute path, starting with /."],
      ["telflo.dockerMounts.1.containerPath", "Use a path outside /app: the image keeps its own files there."],
    ]);
    for (const refused of [
      { telflo: null },
      { telflo: [] },
      { telflo: { dockerMounts: [mount], k8s: true } },
      { telflo: { dockerMounts: [{ ...mount, readOnly: "yes" }] } },
      { telflo: { dockerMounts: [{ hostPath: "/a", containerPath: "/b" }] } },
      { telflo: { dockerMounts: [{ ...mount, mode: "rw" }] } },
    ]) {
      expect(CollectorGroupAnnotationsSchema.safeParse(refused).success).toBe(false);
    }
  });
});

describe("a server group's mounts (D17c-1 decision 31, Preflight ruling 15)", () => {
  const mount = { hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true };

  it.each([
    ["", "Type a path."],
    ["var/log", "Use an absolute path, starting with /."],
    [`/${"a".repeat(1024)}`, "At most 1,024 characters."],
    ["/var/log nginx", "Use letters, digits, dots, dashes, underscores and /."],
    ["/var/$(echo EXPANDED)", "Use letters, digits, dots, dashes, underscores and /."],
    ["/var/log:ro", "Use letters, digits, dots, dashes, underscores and /."],
    ["/var/lög", "Use letters, digits, dots, dashes, underscores and /."],
    ["/var/../etc", "Use no . or .. segment."],
    ["/var/./log", "Use no . or .. segment."],
    ["/..", "Use no . or .. segment."],
  ])("refuses the path %j: %s", (path, words) => {
    expect(mountPathProblem(path)).toBe(words);
    expect(containerPathProblem(path)).toBe(words);
  });

  it("takes an absolute path of the allowed characters at 1,024 characters, dots inside a segment", () => {
    for (const path of ["/", "/var/log/nginx", "/data/", "/var//log", "/a.b/c-d_e/.hidden/x..y", `/${"a".repeat(1023)}`]) {
      expect(mountPathProblem(path)).toBeNull();
    }
  });

  it.each([
    ["/", "Use a directory, not the container's root."],
    ["//", "Use a directory, not the container's root."],
    ["/app", "Use a path outside /app: the image keeps its own files there."],
    ["/app/", "Use a path outside /app: the image keeps its own files there."],
    ["/app/opamp", "Use a path outside /app: the image keeps its own files there."],
    ["//app//bin", "Use a path outside /app: the image keeps its own files there."],
  ])("refuses the container path %j: %s", (path, words) => {
    expect(containerPathProblem(path)).toBe(words);
    expect(mountPathProblem(path)).toBeNull();
  });

  it("takes container paths beside /app", () => {
    for (const path of ["/apps", "/application", "/var/app", "/app-data"]) expect(containerPathProblem(path)).toBeNull();
  });

  it("takes at most 32 mounts, each container path once as Docker reads it, readOnly a boolean", () => {
    const many = Array.from({ length: 32 }, (_, index) => ({ ...mount, containerPath: `/m${index}` }));
    expect(DockerMountsSchema.safeParse(many).success).toBe(true);
    expect(DockerMountsSchema.safeParse([...many, { ...mount, containerPath: "/m32" }]).error?.issues[0]?.message).toBe("At most 32 mounts.");
    const twice = DockerMountsSchema.safeParse([mount, { ...mount, hostPath: "/srv" }, { ...mount, containerPath: "/var//log/nginx/" }]);
    expect(twice.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      ["1.containerPath", "Each container path once."],
      ["2.containerPath", "Each container path once."],
    ]);
    expect(DockerMountsSchema.safeParse([mount, { ...mount, containerPath: "/other" }]).success).toBe(true);
    expect(DockerMountsSchema.safeParse([{ ...mount, readOnly: 1 }]).success).toBe(false);
  });

  it("reads a group's mounts from its annotations: none without them; readOnly missing or malformed as read-only, other keys left out", () => {
    expect(dockerMountsOf(null)).toEqual({ readable: true, mounts: [] });
    expect(dockerMountsOf({})).toEqual({ readable: true, mounts: [] });
    expect(dockerMountsOf({ other: { dockerMounts: [mount] } })).toEqual({ readable: true, mounts: [] });
    expect(dockerMountsOf({ telflo: {} })).toEqual({ readable: true, mounts: [] });
    expect(dockerMountsOf({ telflo: { dockerMounts: [] } })).toEqual({ readable: true, mounts: [] });
    expect(
      dockerMountsOf({
        telflo: {
          dockerMounts: [
            { ...mount, readOnly: false },
            { hostPath: "/a", containerPath: "/b" },
            { hostPath: "/c", containerPath: "/d", readOnly: "no", hostPathType: "Directory" },
          ],
          future: 1,
        },
      }),
    ).toEqual({
      readable: true,
      mounts: [
        { ...mount, readOnly: false },
        { hostPath: "/a", containerPath: "/b", readOnly: true },
        { hostPath: "/c", containerPath: "/d", readOnly: true },
      ],
    });
  });

  it("reads a telflo key it can't read as unreadable, with no mounts: another client's shape, or a mount breaking a rule", () => {
    for (const telflo of [
      null,
      "mounts",
      [mount],
      { dockerMounts: "x" },
      { dockerMounts: [mount, "x"] },
      { dockerMounts: [{ ...mount, hostPath: 42 }] },
      { dockerMounts: [{ ...mount, containerPath: "/app/opamp" }] },
      { dockerMounts: [{ ...mount, hostPath: "relative" }] },
      { dockerMounts: [mount, mount] },
      { dockerMounts: Array.from({ length: 33 }, (_, index) => ({ ...mount, containerPath: `/m${index}` })) },
    ]) {
      expect(dockerMountsOf({ telflo })).toEqual({ readable: false, mounts: [] });
    }
  });

  it("writes the mounts into the annotations read: telflo replaced, other keys kept, telflo removed with none, null when nothing is left", () => {
    const other = { "acme.io/owner": { team: "ops" } };
    expect(annotationsWithDockerMounts({ ...other, telflo: { mounts: "theirs" } }, [mount])).toEqual({ ...other, telflo: { dockerMounts: [mount] } });
    expect(annotationsWithDockerMounts(null, [mount])).toEqual({ telflo: { dockerMounts: [mount] } });
    expect(annotationsWithDockerMounts({ ...other, telflo: { dockerMounts: [mount] } }, [])).toEqual(other);
    expect(annotationsWithDockerMounts({ telflo: { dockerMounts: [mount] } }, [])).toBeNull();
    // Ruling 40: each mount rebuilt from its three fields, whatever else a caller's object holds.
    const widened = { ...mount, hostPathType: "Directory", note: "theirs" } as typeof mount;
    expect(annotationsWithDockerMounts(null, [widened])).toEqual({ telflo: { dockerMounts: [mount] } });
    expect(annotationsWithDockerMounts(null, [])).toBeNull();
    const written = annotationsWithDockerMounts(other, [mount]);
    expect(CollectorGroupAnnotationsSchema.safeParse(written).success).toBe(true);
    expect(dockerMountsOf(written)).toEqual({ readable: true, mounts: [mount] });
  });
});

// D17d-1 decisions 2, 17 and 18, Preflight rulings 11 and 12: a Kubernetes
// group's settings under its annotations' telflo.kubernetes, and their words.
describe("a Kubernetes group's settings (KubernetesAnnotationsSchema)", () => {
  const volume = { hostPath: "/var/log/journal", hostPathType: "Directory", mountPath: "/var/log/journal", readOnly: true };
  const gateway = { role: "gateway", namespace: "observability", replicas: 3, volumes: [volume] };
  const agent = { role: "node", namespace: "telflo-collectors", volumes: [volume] };
  /** Each issue as [its path, its message]. */
  const issues = (value: unknown) =>
    KubernetesAnnotationsSchema.safeParse(value).error?.issues.map((issue) => [issue.path.join("."), issue.message]);

  it("takes a role, a namespace, a gateway's replicas and hostPath volumes, each volume's four fields", () => {
    expect(KubernetesAnnotationsSchema.parse(gateway)).toEqual(gateway);
    expect(KubernetesAnnotationsSchema.parse(agent)).toEqual(agent);
    expect(KubernetesAnnotationsSchema.parse({ role: "cluster", namespace: "a".repeat(63), volumes: [] })).toEqual({ role: "cluster", namespace: "a".repeat(63), volumes: [] });
    const { replicas: _replicas, ...withoutReplicas } = gateway;
    expect(KubernetesAnnotationsSchema.safeParse(withoutReplicas).success).toBe(true);
    for (const hostPathType of ["Directory", "DirectoryOrCreate", "File", "Socket"]) {
      expect(KubernetesAnnotationsSchema.safeParse({ ...agent, volumes: [{ ...volume, hostPathType }] }).success).toBe(true);
    }
    expect(KubernetesAnnotationsSchema.safeParse({ ...agent, volumes: [{ ...volume, readOnly: false }] }).success).toBe(true);
  });

  it("is strict: no other key on the settings or a volume, every key but replicas required, the role one of the three", () => {
    for (const refused of [
      { ...gateway, starter: true },
      { ...gateway, volumes: [{ ...volume, type: "hostPath" }] },
      { ...gateway, role: "sidecar" },
      { ...gateway, role: null },
      { namespace: "observability", volumes: [] },
      { role: "gateway", volumes: [] },
      { role: "gateway", namespace: "observability" },
      { ...gateway, replicas: null },
      { ...gateway, volumes: [{ hostPath: "/a", hostPathType: "Directory", mountPath: "/b" }] },
      { ...gateway, volumes: [{ ...volume, readOnly: "yes" }] },
    ]) {
      expect(KubernetesAnnotationsSchema.safeParse(refused).success).toBe(false);
    }
  });

  it.each([
    ["", "A namespace is required."],
    ["a".repeat(64), "Namespace must be 63 characters or fewer."],
    ["-telemetry", "Use lowercase letters, numbers, and hyphens; must start and end with a letter or number."],
    ["telemetry-", "Use lowercase letters, numbers, and hyphens; must start and end with a letter or number."],
    ["Telemetry", "Use lowercase letters, numbers, and hyphens; must start and end with a letter or number."],
    ["tele_metry", "Use lowercase letters, numbers, and hyphens; must start and end with a letter or number."],
    [" telemetry", "Use lowercase letters, numbers, and hyphens; must start and end with a letter or number."],
  ])("refuses the namespace %j: %s", (namespace, words) => {
    expect(kubernetesNamespaceProblem(namespace)).toBe(words);
    expect(issues({ ...gateway, namespace })).toEqual([["namespace", words]]);
  });

  it("takes a namespace of a DNS-1123 label: digits first, inner hyphens, 63 characters", () => {
    for (const namespace of ["0", "telflo-collectors", "a1-b2", "a".repeat(63)]) expect(kubernetesNamespaceProblem(namespace)).toBeNull();
  });

  it("takes a gateway's replicas from 1 to 1,000 whole, saying so otherwise; refuses them on the Agent and the Cluster", () => {
    expect(KubernetesAnnotationsSchema.safeParse({ ...gateway, replicas: 1 }).success).toBe(true);
    expect(KubernetesAnnotationsSchema.safeParse({ ...gateway, replicas: 1000 }).success).toBe(true);
    for (const replicas of [0, 1001, 1.5, -1, "3"]) {
      expect(issues({ ...gateway, replicas })).toEqual([["replicas", "Use a whole number from 1 to 1,000."]]);
    }
    expect(issues({ ...agent, replicas: 1 })).toEqual([["replicas", "Replicas are a gateway's only."]]);
    expect(issues({ role: "cluster", namespace: "x", replicas: 2, volumes: [] })).toEqual([["replicas", "Replicas are a gateway's only."]]);
  });

  it("checks each volume's paths by the mounts' rules and its type, each problem at its field", () => {
    expect(
      issues({
        ...gateway,
        volumes: [
          { ...volume, hostPath: "var/log" },
          { ...volume, mountPath: "/app/opamp" },
          { ...volume, mountPath: "/" },
          { ...volume, hostPath: "/var/$(echo EXPANDED)", mountPath: "/x" },
          { ...volume, hostPathType: "BlockDevice", mountPath: "/y" },
        ],
      }),
    ).toEqual([
      ["volumes.0.hostPath", "Use an absolute path, starting with /."],
      ["volumes.1.mountPath", "Use a path outside /app: the image keeps its own files there."],
      ["volumes.2.mountPath", "Use a directory, not the container's root."],
      ["volumes.3.hostPath", "Use letters, digits, dots, dashes, underscores and /."],
      ["volumes.4.hostPathType", "Choose Directory, DirectoryOrCreate, File or Socket."],
    ]);
  });

  it("takes at most 32 volumes, saying so", () => {
    const many = Array.from({ length: 32 }, (_, index) => ({ ...volume, mountPath: `/m${index}` }));
    expect(KubernetesAnnotationsSchema.safeParse({ ...gateway, volumes: many }).success).toBe(true);
    expect(issues({ ...gateway, volumes: [...many, { ...volume, mountPath: "/m32" }] })).toEqual([["volumes", "A group holds at most 32 volumes."]]);
  });

  it("takes each mount path once as read, and refuses two mount paths naming the same volume in the chart", () => {
    expect(
      issues({
        ...gateway,
        volumes: [
          { ...volume, mountPath: "/data" },
          { ...volume, mountPath: "/data/", hostPath: "/srv" },
          { ...volume, mountPath: "//data" },
          { ...volume, mountPath: "/var/log" },
          { ...volume, mountPath: "/var-log" },
          { ...volume, mountPath: "/VAR/LOG" },
          { ...volume, mountPath: "/var.log/" },
          { ...volume, mountPath: "/var/log2" },
        ],
      }),
    ).toEqual([
      ["volumes.1.mountPath", "Each mount path once."],
      ["volumes.2.mountPath", "Each mount path once."],
      ["volumes.4.mountPath", "Two mount paths would name the same volume: change one."],
      ["volumes.5.mountPath", "Two mount paths would name the same volume: change one."],
      ["volumes.6.mountPath", "Two mount paths would name the same volume: change one."],
    ]);
  });

  it("names a volume by its mount path exactly as the platform's chart does (charts/supervisor-collector/templates/_helpers.tpl)", () => {
    expect(kubernetesVolumeName("/var/log/pods")).toBe("extra-var-log-pods");
    expect(kubernetesVolumeName("/var/lib/docker/containers/")).toBe("extra-var-lib-docker-containers");
    expect(kubernetesVolumeName("/Data_Dir/x.y")).toBe("extra-data-dir-x-y");
    // trimPrefix "/" takes one: a second becomes the hyphen trimPrefix "-" takes.
    expect(kubernetesVolumeName("//var")).toBe("extra-var");
    expect(kubernetesVolumeName("/-a-")).toBe("extra-a");
    expect(kubernetesVolumeName("/a--b__c")).toBe("extra-a-b-c");
    // trunc 63, then trimSuffix "-".
    expect(kubernetesVolumeName(`/${"a".repeat(70)}`)).toBe(`extra-${"a".repeat(57)}`);
    expect(kubernetesVolumeName(`/${"a".repeat(56)}/bbbb`)).toBe(`extra-${"a".repeat(56)}`);
    expect(kubernetesVolumeName(`/${"a".repeat(56)}/bbbb`)).toHaveLength(62);
  });

  it("refuses the Agent a mount at /var/log/pods (as read), which the chart's DaemonSet mounts itself; the Cluster and a gateway may", () => {
    expect(issues({ ...agent, volumes: [volume, { ...volume, mountPath: "/var/log/pods" }] })).toEqual([
      ["volumes.1.mountPath", "The Agent already mounts the node's /var/log/pods there, for pod logs: mount another path."],
    ]);
    expect(issues({ ...agent, volumes: [{ ...volume, mountPath: "/var//log/pods/" }] })).toEqual([
      ["volumes.0.mountPath", "The Agent already mounts the node's /var/log/pods there, for pod logs: mount another path."],
    ]);
    expect(KubernetesAnnotationsSchema.safeParse({ ...agent, volumes: [{ ...volume, hostPath: "/var/log/pods", mountPath: "/node/pods" }] }).success).toBe(true);
    for (const role of ["cluster", "gateway"]) {
      expect(KubernetesAnnotationsSchema.safeParse({ role, namespace: "x", volumes: [{ ...volume, mountPath: "/var/log/pods" }] }).success).toBe(true);
    }
  });

  it("sits under the annotations' telflo key beside the mounts, each optional, each problem at its path there", () => {
    const mount = { hostPath: "/var/log", containerPath: "/logs", readOnly: true };
    expect(TelfloAnnotationsSchema.safeParse({}).success).toBe(true);
    expect(TelfloAnnotationsSchema.safeParse({ kubernetes: gateway }).success).toBe(true);
    // Both together are the contract's; which one a group may hold is its fleet type's (the API's check).
    expect(TelfloAnnotationsSchema.safeParse({ dockerMounts: [mount], kubernetes: gateway }).success).toBe(true);
    expect(TelfloAnnotationsSchema.safeParse({ kubernetes: gateway, helm: {} }).success).toBe(false);
    expect(TelfloAnnotationsSchema.safeParse({ kubernetes: null }).success).toBe(false);
    const annotationIssues = (value: unknown) =>
      CollectorGroupAnnotationsSchema.safeParse(value).error?.issues.map((issue) => [issue.path.join("."), issue.message]);
    expect(annotationIssues({ telflo: { kubernetes: { ...agent, replicas: 2, volumes: [{ ...volume, mountPath: "/var/log/pods" }] } }, other: 1 })).toEqual([
      ["telflo.kubernetes.replicas", "Replicas are a gateway's only."],
      ["telflo.kubernetes.volumes.0.mountPath", "The Agent already mounts the node's /var/log/pods there, for pod logs: mount another path."],
    ]);
  });
});

describe("a Kubernetes fleet's group names and roles (Preflight rulings 11 and 12)", () => {
  it.each([
    ["", "A gateway name is required."],
    ["a".repeat(53), "Gateway name must be 52 characters or fewer."],
    ["node", "node, cluster, telflo-node and telflo-cluster are reserved: choose another name."],
    ["cluster", "node, cluster, telflo-node and telflo-cluster are reserved: choose another name."],
    ["telflo-node", "node, cluster, telflo-node and telflo-cluster are reserved: choose another name."],
    ["telflo-cluster", "node, cluster, telflo-node and telflo-cluster are reserved: choose another name."],
    ["1-traces", "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."],
    ["traces-", "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."],
    ["Traces", "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."],
    ["traces sampling", "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."],
    ["Default", "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."],
  ])("refuses the gateway name %j: %s", (name, words) => {
    expect(gatewayNameProblem(name)).toBe(words);
  });

  it("takes a DNS-1035 label of at most 52 characters as a gateway's name; its words never repeat the name", () => {
    for (const name of ["a", "traces-sampling", "g2", `a${"-b".repeat(25)}a`.slice(0, 52), "a".repeat(52), "default"]) {
      expect(gatewayNameProblem(name)).toBeNull();
    }
    expect(KUBERNETES_RESERVED_GROUP_NAMES).toEqual(["node", "cluster", "telflo-node", "telflo-cluster"]);
    for (const name of ["Secret-Pool", "x".repeat(60), "pool_9"]) expect(gatewayNameProblem(name)).not.toContain(name);
  });

  it("gives a group's role from its fleet: none on a server fleet; the Default group the Agent, `cluster` the Cluster, any other a gateway", () => {
    expect(collectorGroupRole({ isDefault: true, name: "Default" }, "server")).toBeNull();
    expect(collectorGroupRole({ isDefault: false, name: "cluster" }, "server")).toBeNull();
    expect(collectorGroupRole({ isDefault: true, name: "Default" }, "kubernetes-supervisor")).toBe("node");
    expect(collectorGroupRole({ isDefault: false, name: "cluster" }, "kubernetes-supervisor")).toBe("cluster");
    expect(collectorGroupRole({ isDefault: false, name: "traces-sampling" }, "kubernetes-supervisor")).toBe("gateway");
    // The name alone never makes the Agent, nor the case the Cluster.
    expect(collectorGroupRole({ isDefault: false, name: "node" }, "kubernetes-supervisor")).toBe("gateway");
    expect(collectorGroupRole({ isDefault: false, name: "Cluster" }, "kubernetes-supervisor")).toBe("gateway");
  });
});

describe("reading and writing a Kubernetes group's settings (kubernetesOf, annotationsWithKubernetes)", () => {
  const volume = { hostPath: "/var/log/journal", hostPathType: "Directory", mountPath: "/var/log/journal", readOnly: true } as const;
  const settings = { role: "gateway", namespace: "observability", replicas: 3, volumes: [volume] } as const;
  const kubernetes = { ...settings, volumes: [...settings.volumes] };

  it("reads none without them: no annotations, no telflo key, no kubernetes key (the Agent before its first save)", () => {
    expect(kubernetesOf(null)).toEqual({ readable: true, kubernetes: null });
    expect(kubernetesOf(undefined)).toEqual({ readable: true, kubernetes: null });
    expect(kubernetesOf({})).toEqual({ readable: true, kubernetes: null });
    expect(kubernetesOf({ other: { kubernetes: settings } })).toEqual({ readable: true, kubernetes: null });
    expect(kubernetesOf({ telflo: {} })).toEqual({ readable: true, kubernetes: null });
    expect(kubernetesOf({ telflo: { dockerMounts: [] } })).toEqual({ readable: true, kubernetes: null });
    expect(kubernetesOf({ telflo: { kubernetes: settings } })).toEqual({ readable: true, kubernetes });
  });

  it("reads leniently: readOnly missing or malformed as read-only, hostPathType missing as Directory, volumes missing as none, replicas null as none, other keys left out", () => {
    expect(
      kubernetesOf({
        telflo: {
          kubernetes: {
            role: "gateway",
            namespace: "observability",
            replicas: null,
            volumes: [
              { type: "hostPath", hostPath: "/a", mountPath: "/b" },
              { hostPath: "/c", hostPathType: "File", mountPath: "/d", readOnly: "no" },
              { hostPath: "/e", hostPathType: "Socket", mountPath: "/f", readOnly: false },
            ],
            variableGroupId: "theirs",
          },
          future: 1,
        },
      }),
    ).toEqual({
      readable: true,
      kubernetes: {
        role: "gateway",
        namespace: "observability",
        volumes: [
          { hostPath: "/a", hostPathType: "Directory", mountPath: "/b", readOnly: true },
          { hostPath: "/c", hostPathType: "File", mountPath: "/d", readOnly: true },
          { hostPath: "/e", hostPathType: "Socket", mountPath: "/f", readOnly: false },
        ],
      },
    });
    expect(kubernetesOf({ telflo: { kubernetes: { role: "cluster", namespace: "x" } } })).toEqual({
      readable: true,
      kubernetes: { role: "cluster", namespace: "x", volumes: [] },
    });
  });

  it("reads what it can't read as unreadable, with no settings: another client's shape, or a setting breaking a rule", () => {
    for (const telflo of [
      null,
      "kubernetes",
      [settings],
      { kubernetes: null },
      { kubernetes: "gateway" },
      { kubernetes: [settings] },
      { kubernetes: { ...settings, role: "sidecar" } },
      { kubernetes: { ...settings, role: undefined } },
      { kubernetes: { role: "gateway", volumes: [] } },
      { kubernetes: { ...settings, namespace: "Observability" } },
      { kubernetes: { ...settings, replicas: 0 } },
      { kubernetes: { ...settings, role: "cluster" } },
      { kubernetes: { ...settings, volumes: "x" } },
      { kubernetes: { ...settings, volumes: [volume, "x"] } },
      { kubernetes: { ...settings, volumes: [{ ...volume, hostPath: 42 }] } },
      { kubernetes: { ...settings, volumes: [{ ...volume, hostPathType: "BlockDevice" }] } },
      { kubernetes: { ...settings, volumes: [volume, volume] } },
      { kubernetes: { ...settings, volumes: Array.from({ length: 33 }, (_, index) => ({ ...volume, mountPath: `/m${index}` })) } },
      { kubernetes: { role: "node", namespace: "x", volumes: [{ ...volume, mountPath: "/var/log/pods" }] } },
    ]) {
      expect(kubernetesOf({ telflo })).toEqual({ readable: false, kubernetes: null });
    }
  });

  it("writes the settings into the annotations read: telflo rebuilt as {kubernetes} only, a stray dockerMounts dropped, other keys kept", () => {
    const other = { "acme.io/owner": { team: "ops" } };
    const mount = { hostPath: "/var/log", containerPath: "/logs", readOnly: true };
    expect(annotationsWithKubernetes({ ...other, telflo: { dockerMounts: [mount], future: 1 } }, kubernetes)).toEqual({ ...other, telflo: { kubernetes } });
    expect(annotationsWithKubernetes(null, kubernetes)).toEqual({ telflo: { kubernetes } });
    expect(annotationsWithKubernetes({ ...other, telflo: { kubernetes } }, null)).toEqual(other);
    expect(annotationsWithKubernetes({ telflo: { kubernetes } }, null)).toBeNull();
    expect(annotationsWithKubernetes(null, null)).toBeNull();
    // Rebuilt from their own fields, whatever else a caller's object holds; no replicas key without replicas.
    const widened = { role: "node", namespace: "x", volumes: [{ ...volume, type: "hostPath" }], starter: true } as unknown as Parameters<typeof annotationsWithKubernetes>[1];
    expect(annotationsWithKubernetes(null, widened)).toEqual({ telflo: { kubernetes: { role: "node", namespace: "x", volumes: [volume] } } });
    const written = annotationsWithKubernetes(other, kubernetes);
    expect(CollectorGroupAnnotationsSchema.safeParse(written).success).toBe(true);
    expect(kubernetesOf(written)).toEqual({ readable: true, kubernetes });
  });
});

describe("a collector's pin, update and bulk pin", () => {
  it("pins a configuration version, or unpins with null; never a raw publication id, nor an import (D16c)", () => {
    expect(CollectorPinRequestSchema.parse({ kind: "version", versionId: ID })).toEqual({ kind: "version", versionId: ID });
    expect(CollectorPinRequestSchema.parse(null)).toBeNull();
    for (const pin of [
      { kind: "publication", id: ID },
      { kind: "import", importId: ID },
      { kind: "version", importId: ID },
      { kind: "version", versionId: ID, importId: ID },
      { kind: "version", versionId: "42" },
    ]) {
      expect(CollectorPinRequestSchema.safeParse(pin).success).toBe(false);
    }
  });

  it("takes 1 to 500 collector ids and a pin", () => {
    expect(PinCollectorsRequestSchema.parse({ collectorIds: [ID], pin: null })).toEqual({ collectorIds: [ID], pin: null });
    expect(PinCollectorsRequestSchema.safeParse({ collectorIds: Array(500).fill(ID), pin: null }).success).toBe(true);
    expect(PinCollectorsRequestSchema.safeParse({ collectorIds: Array(501).fill(ID), pin: null }).success).toBe(false);
    expect(PinCollectorsRequestSchema.safeParse({ collectorIds: [], pin: null }).success).toBe(false);
    expect(PinCollectorsRequestSchema.safeParse({ collectorIds: [ID], pin: { kind: "import", importId: ID } }).success).toBe(false);
  });

  it("takes a pin, a variable group, or both, and refuses neither: a field left out leaves each collector's as it is (Q103)", () => {
    const pin = { kind: "version", versionId: ID } as const;
    expect(PinCollectorsRequestSchema.parse({ collectorIds: [ID], pinnedVariableGroupId: ID })).toEqual({ collectorIds: [ID], pinnedVariableGroupId: ID });
    expect(PinCollectorsRequestSchema.parse({ collectorIds: [ID], pinnedVariableGroupId: null })).toEqual({ collectorIds: [ID], pinnedVariableGroupId: null });
    expect(PinCollectorsRequestSchema.parse({ collectorIds: [ID], pin, pinnedVariableGroupId: ID })).toEqual({ collectorIds: [ID], pin, pinnedVariableGroupId: ID });
    expect(PinCollectorsRequestSchema.safeParse({ collectorIds: [ID] }).success).toBe(false);
    expect(PinCollectorsRequestSchema.safeParse({ collectorIds: [ID], pin: undefined, pinnedVariableGroupId: undefined }).success).toBe(false);
    expect(PinCollectorsRequestSchema.safeParse({ collectorIds: [ID], pinnedVariableGroupId: "42" }).success).toBe(false);
    expect(PinCollectorsRequestSchema.safeParse({ collectorIds: [ID], variableGroupId: ID }).success).toBe(false);
  });

  it("updates a collector's pinned variable group alone, or with the rest; null returns it to its group's (D20 decision 4)", () => {
    expect(UpdateCollectorRequestSchema.parse({ pinnedVariableGroupId: ID })).toEqual({ pinnedVariableGroupId: ID });
    expect(UpdateCollectorRequestSchema.parse({ pinnedVariableGroupId: null })).toEqual({ pinnedVariableGroupId: null });
    expect(UpdateCollectorRequestSchema.parse({ pin: null, pinnedVariableGroupId: ID })).toEqual({ pin: null, pinnedVariableGroupId: ID });
    expect(UpdateCollectorRequestSchema.safeParse({ pinnedVariableGroupId: "42" }).success).toBe(false);
    expect(UpdateCollectorRequestSchema.safeParse({ pinnedVariableGroupId: undefined }).success).toBe(false);
  });

  it("updates a name (1 to 200 characters), a group or a pin; at least one, a null pin unpinning", () => {
    expect(UpdateCollectorRequestSchema.parse({ pin: null })).toEqual({ pin: null });
    expect(UpdateCollectorRequestSchema.parse({ name: "\u{1F680}".repeat(200) })).toEqual({ name: "\u{1F680}".repeat(200) });
    expect(UpdateCollectorRequestSchema.safeParse({ name: "a".repeat(201) }).success).toBe(false);
    expect(UpdateCollectorRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateCollectorRequestSchema.safeParse({ groupId: "42" }).success).toBe(false);
    expect(UpdateCollectorRequestSchema.safeParse({ fleetId: ID }).success).toBe(false);
    expect(UpdateCollectorRequestSchema.safeParse({ pin: { kind: "import", importId: ID } }).success).toBe(false);
  });
});

describe("the collector list's and the pages' queries", () => {
  it("defaults the limit to 50; takes q of at most 100 characters, a group, a sort, an order and a cursor", () => {
    expect(ListCollectorsQuerySchema.parse({})).toEqual({ limit: 50 });
    const query = { q: "\u{1F680}".repeat(100), groupId: ID, sort: "lastSeen", order: "asc", limit: "100", cursor: "abc" };
    expect(ListCollectorsQuerySchema.parse(query)).toEqual({ ...query, limit: 100 });
    for (const refused of [{ q: "a".repeat(101) }, { q: "a\u0000" }, { sort: "size" }, { order: "up" }, { groupId: "42" }, { limit: "0" }, { status: "online" }]) {
      expect(ListCollectorsQuerySchema.safeParse(refused).success).toBe(false);
    }
    expect(FleetsPageQuerySchema.parse({ limit: "2", cursor: "x" })).toEqual({ limit: 2, cursor: "x" });
    expect(FleetsPageQuerySchema.safeParse({ q: "x" }).success).toBe(false);
  });
});

describe("the collectors' replies", () => {
  // Ruling 31 m5: the platform's names say "published version", and a
  // reply's pin is named as a pin's request is.
  const VERSION = {
    configurationId: ID,
    configurationName: "c",
    versionId: ID,
    versionNumber: 1,
    versionLabel: null,
    collectorDistribution: "otelcol-contrib",
    collectorVersion: "0.159.0",
  };
  const SHA = "a".repeat(64);

  it("answers a collector's pinned variable group, required and nullable (D20, Preflight ruling 23)", () => {
    const collector = {
      id: ID,
      instanceUid: ID,
      name: "edge-01",
      fleetId: ID,
      groupId: ID,
      pin: null,
      pinnedVariableGroupId: null,
      resolution: null,
      served: null,
      effective: null,
      reported: { collectorVersion: null, ip: null, hostIp: null, attributes: null },
      enrollmentTokenId: null,
      lastSeenAt: NOW,
      liveness: "online",
      drift: "unassigned",
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(CollectorSchema.parse(collector)).toEqual(collector);
    expect(CollectorSchema.parse({ ...collector, pinnedVariableGroupId: ID })).toMatchObject({ pinnedVariableGroupId: ID });
    const { pinnedVariableGroupId: _pinned, ...withoutPinned } = collector;
    expect(CollectorSchema.safeParse(withoutPinned).success).toBe(false);
    expect(CollectorSchema.safeParse({ ...collector, pinnedVariableGroupId: "eu-edge" }).success).toBe(false);
  });

  it("answers a pin re-sendable as its request: a version's versionId (null for an orphan) beside its published version's id, never an import", () => {
    const pinned = { kind: "version", versionId: ID, publishedVersionId: ID, version: VERSION };
    expect(CollectorPinSchema.parse(pinned)).toEqual(pinned);
    const orphan = { kind: "version", versionId: null, publishedVersionId: ID, version: null };
    expect(CollectorPinSchema.parse(orphan)).toEqual(orphan);
    // What a reply's pin holds is a pin's request's kind and id, sent back.
    expect(CollectorPinRequestSchema.parse({ kind: pinned.kind, versionId: pinned.versionId })).toEqual({ kind: "version", versionId: ID });
    for (const refused of [
      { kind: "publication", id: ID, version: null },
      { kind: "version", publishedVersionId: ID, version: null },
      { kind: "import", importId: ID },
      { kind: "import", importId: ID, version: null },
      { kind: "import", id: ID },
    ]) {
      expect(CollectorPinSchema.safeParse(refused).success).toBe(false);
    }
  });

  it("answers a resolution from a pinned version or the group's version, by its published version's id; never a pinned import", () => {
    for (const from of ["pinnedVersion", "groupVersion"]) {
      const resolution = { from, publishedVersionId: ID, sha256: SHA, version: null };
      expect(CollectorResolutionSchema.parse(resolution)).toEqual(resolution);
    }
    for (const refused of [
      { from: "pinnedImport", importId: ID, sha256: SHA },
      { from: "pinnedPublication", id: ID, sha256: SHA, version: null },
      { from: "groupPublication", publishedVersionId: ID, sha256: SHA, version: null },
      { from: "pinnedImport", publishedVersionId: ID, sha256: SHA },
      { from: "groupVersion", importId: ID, sha256: SHA, version: null },
    ]) {
      expect(CollectorResolutionSchema.safeParse(refused).success).toBe(false);
    }
  });

  it("answers what was served as a version by its published version's id, null once deleted; never an import", () => {
    for (const served of [
      { kind: "version", publishedVersionId: ID, sha256: SHA, at: NOW, version: VERSION },
      { kind: "version", publishedVersionId: null, sha256: SHA, at: null, version: null },
    ]) {
      expect(CollectorServedSchema.parse(served)).toEqual(served);
    }
    for (const refused of [
      { kind: null, id: null, sha256: SHA, at: null, version: null },
      { kind: "publication", id: ID, sha256: SHA, at: NOW, version: null },
      { kind: "import", importId: ID, sha256: SHA, at: NOW },
      { kind: "import", importId: ID, sha256: SHA, at: NOW, version: null },
    ]) {
      expect(CollectorServedSchema.safeParse(refused).success).toBe(false);
    }
  });

  it("answers a group's assignment as assignedPublishedVersionId, and a usage's entries as publishedVersions by publishedVersionId", () => {
    const group = {
      id: ID,
      fleetId: ID,
      name: "Default",
      isDefault: true,
      annotations: null,
      assignedPublishedVersionId: ID,
      assignedVersion: VERSION,
      variableGroupId: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(CollectorGroupSchema.parse(group)).toEqual(group);
    // D20 (Preflight ruling 23): the variable group it uses, required and nullable.
    expect(CollectorGroupSchema.parse({ ...group, variableGroupId: ID })).toMatchObject({ variableGroupId: ID });
    const { variableGroupId: _variableGroupId, ...withoutVariableGroup } = group;
    expect(CollectorGroupSchema.safeParse(withoutVariableGroup).success).toBe(false);
    // D17c-1 decision 30: the annotations passed through, whatever they hold.
    const annotated = { ...group, annotations: { telflo: { dockerMounts: [] }, "acme.io/owner": ["ops", { n: 1 }] } };
    expect(CollectorGroupSchema.parse(annotated)).toEqual(annotated);
    // D17d-1 decision 2: no Kubernetes field beside them; an unreadable telflo key still passes through.
    expect(CollectorGroupSchema.safeParse({ ...group, role: null }).success).toBe(false);
    expect(CollectorGroupSchema.safeParse({ ...group, volumes: null }).success).toBe(false);
    const unreadable = { ...group, annotations: { telflo: { kubernetes: { role: "sidecar" } } } };
    expect(CollectorGroupSchema.parse(unreadable)).toEqual(unreadable);
    const { annotations: _annotations, ...withoutAnnotations } = group;
    expect(CollectorGroupSchema.safeParse(withoutAnnotations).success).toBe(false);
    expect(CollectorGroupSchema.safeParse({ ...group, annotations: [] }).success).toBe(false);
    // D17c-1 decision 33: a published version names its collector.
    const { collectorVersion: _collectorVersion, ...withoutCollector } = VERSION;
    expect(CollectorGroupSchema.safeParse({ ...group, assignedVersion: withoutCollector }).success).toBe(false);
    const { assignedPublishedVersionId: _renamed, ...rest } = group;
    expect(CollectorGroupSchema.safeParse({ ...rest, assignedPublicationId: ID }).success).toBe(false);
    const entry = { publishedVersionId: ID, publishedAt: NOW, groups: [{ fleetId: ID, groupId: ID }], pinnedCollectors: 2, version: null, recorded: { number: 1, label: null } };
    const usage = { configurationId: ID, inUse: true, publishedVersions: [entry] };
    expect(ConfigurationFleetUsageSchema.parse(usage)).toEqual(usage);
    expect(ConfigurationFleetUsageSchema.safeParse({ configurationId: ID, inUse: true, publications: [] }).success).toBe(false);
    const { publishedVersionId: _id, ...withoutId } = entry;
    expect(ConfigurationFleetUsageSchema.safeParse({ ...usage, publishedVersions: [{ ...withoutId, id: ID }] }).success).toBe(false);
  });
});
