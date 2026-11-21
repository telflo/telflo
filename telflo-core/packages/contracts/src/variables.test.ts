import { describe, expect, it } from "vitest";
import { CONFIGURATION_ERROR_CODES } from "./configurations.js";
import { FLEET_ERROR_CODES } from "./fleets.js";
import { FLOW_ERROR_CODES } from "./flows.js";
import { IDENTITY_ERROR_CODES } from "./identity.js";
import { ORGANIZATION_ERROR_CODES } from "./organizations.js";
import { SALES_INQUIRY_ERROR_CODES } from "./sales-inquiries.js";
import { OIDC_QUERY_ERROR_CODES, SESSION_ERROR_CODES } from "./sessions.js";
import { TEST_REGEX_ERROR_CODES } from "./test-regexes.js";
import { TESTING_ERROR_CODES } from "./test-runs.js";
import { VALIDATION_RULES_ERROR_CODES } from "./validation-rules.js";
import {
  CreateOrganizationVariableRequestSchema,
  CreateVariableGroupRequestSchema,
  ORGANIZATION_VARIABLES_MAXIMUM,
  OrganizationVariableSchema,
  OrganizationVariablesResponseSchema,
  UpdateOrganizationVariableRequestSchema,
  UpdateVariableGroupRequestSchema,
  VARIABLE_ERROR_CODES,
  VariableDescriptionSchema,
  VariableGroupDetailSchema,
  VariableGroupInUseDetailsSchema,
  VariableGroupNameSchema,
  VariableGroupOverrideRequestSchema,
  VariableGroupSchema,
  VariableGroupsResponseSchema,
  VariableInUseDetailsSchema,
  VariableNameSchema,
  VariableReferenceNameSchema,
  VariablesUndefinedDetailsSchema,
  VariableValueSchema,
  VARIABLE_GROUPS_MAXIMUM,
  VARIABLE_VALUE_MAXIMUM_LENGTH,
  VARIABLES_UNAVAILABLE_MESSAGE,
  VARIABLES_UNAVAILABLE_RUN_MESSAGE,
} from "./variables.js";

// The organization variables' contracts: every bound counted in code points
// as the opamp-server's char_length counts them, the UPPER_CASE name rule
// on a create's or a rename's request only (a reply's name has the
// server's grammar, lowercase included), a value on one line, the details'
// 100 entries with nullable names, and the error codes.

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70";
const NOW = "2026-10-20T10:00:00.000Z";
const ACTOR = { userId: ID, email: "sam@acme.io" };
/** A 4-byte character: one code point, two UTF-16 units. */
const ASTRAL = "\u{1F680}";
/** U+2028 and U+2029, made from their code points so no file holds them raw. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * A value of `length` code points the value pattern takes: astral
 * characters, `$` and text, never U+2028 or U+2029.
 */
function valueOf(length: number): string {
  const unit = [ASTRAL, "$", "a", "{", "é"];
  return Array.from({ length }, (_, index) => unit[index % unit.length]).join("");
}

/** A name of `length` characters in the server's grammar; `upper` keeps the platform's. */
function nameOf(length: number, upper = true): string {
  return (upper ? "N" : "n") + (upper ? "A_1" : "a_1").repeat(length).slice(0, length - 1);
}

const variable = {
  id: ID,
  name: "OTLP_ENDPOINT",
  value: "https://otel.example:4317",
  description: "Where the gateways send.",
  changedBy: ACTOR,
  changedAt: NOW,
};

const variableGroup = {
  id: ID,
  name: "eu-edge",
  description: null,
  overrideCount: 2,
  usage: { collectorGroups: 1, pinnedCollectors: 3 },
  changedBy: null,
  changedAt: NOW,
};

describe("a variable's bounds, in code points", () => {
  it("takes a name of 1 to 128 characters, and refuses 0 or 129", () => {
    for (const schema of [VariableNameSchema, VariableReferenceNameSchema]) {
      expect(schema.safeParse(nameOf(1)).success).toBe(true);
      expect(schema.safeParse(nameOf(128)).success).toBe(true);
      expect(schema.safeParse(nameOf(129)).success).toBe(false);
      expect(schema.safeParse("").success).toBe(false);
    }
    expect(nameOf(128)).toHaveLength(128);
  });

  it("takes a value of 0 to 1,024 code points, astral characters counted once each", () => {
    expect(VARIABLE_VALUE_MAXIMUM_LENGTH).toBe(1024);
    expect(VariableValueSchema.safeParse("").success).toBe(true);
    const longest = ASTRAL.repeat(1024);
    expect(longest.length).toBe(2048);
    expect(VariableValueSchema.safeParse(longest).success).toBe(true);
    expect(VariableValueSchema.safeParse(valueOf(1024)).success).toBe(true);
    expect(VariableValueSchema.safeParse(ASTRAL.repeat(1025)).success).toBe(false);
    expect(VariableValueSchema.safeParse(valueOf(1025)).success).toBe(false);
    expect(VariableValueSchema.safeParse("a".repeat(1025)).success).toBe(false);
    for (const schema of [VariableGroupOverrideRequestSchema, UpdateOrganizationVariableRequestSchema]) {
      expect(schema.safeParse({ value: valueOf(1024) }).success).toBe(true);
      expect(schema.safeParse({ value: valueOf(1025) }).success).toBe(false);
    }
  });

  it("takes a description of 1 to 1,000 code points, or null", () => {
    expect(VariableDescriptionSchema.safeParse(null).success).toBe(true);
    expect(VariableDescriptionSchema.safeParse("a").success).toBe(true);
    expect(VariableDescriptionSchema.safeParse(ASTRAL.repeat(1000)).success).toBe(true);
    expect(VariableDescriptionSchema.safeParse(ASTRAL.repeat(1001)).success).toBe(false);
    expect(VariableDescriptionSchema.safeParse("").success).toBe(false);
  });

  it("takes a variable group's name of 1 to 200 code points", () => {
    expect(VariableGroupNameSchema.safeParse("a").success).toBe(true);
    expect(VariableGroupNameSchema.safeParse(ASTRAL.repeat(200)).success).toBe(true);
    expect(VariableGroupNameSchema.safeParse(ASTRAL.repeat(201)).success).toBe(false);
    expect(VariableGroupNameSchema.safeParse("").success).toBe(false);
  });

  it.each([
    ["a leading space", " eu-edge"],
    ["a trailing no-break space", "eu-edge\u00a0"],
    ["a trailing line separator", `eu-edge${LINE_SEPARATOR}`],
    ["a tab inside", "eu\tedge"],
    ["a line feed inside", "eu\nedge"],
    ["a C1 control inside", "eu\u0085edge"],
    ["U+0000", "eu\u0000"],
  ])("refuses a description or a group name with %s: neither is trimmed for the sender", (_label, value) => {
    expect(VariableDescriptionSchema.safeParse(value).success).toBe(false);
    expect(VariableGroupNameSchema.safeParse(value).success).toBe(false);
  });

  it("takes a description with a line separator inside, as the server's pattern does", () => {
    expect(VariableDescriptionSchema.safeParse(`a${LINE_SEPARATOR}b`).success).toBe(true);
  });
});

describe("a value on one line", () => {
  it.each([
    ["a line feed", "a\nb"],
    ["a carriage return", "a\rb"],
    ["a tab", "a\tb"],
    ["U+0000", "a\u0000b"],
    ["DEL", "a\u007fb"],
    ["a C1 control (NEL)", "a\u0085b"],
    ["U+2028", `a${LINE_SEPARATOR}b`],
    ["U+2029", `a${PARAGRAPH_SEPARATOR}b`],
  ])("refuses %s", (_label, value) => {
    expect(VariableValueSchema.safeParse(value).success).toBe(false);
    expect(VariableGroupOverrideRequestSchema.safeParse({ value }).success).toBe(false);
    expect(OrganizationVariableSchema.safeParse({ ...variable, value }).success).toBe(false);
  });

  it.each([
    ["a dollar", "a$b"],
    ["another provider's reference, kept literal", "${env:REGION}"],
    ["spaces at either end, kept as sent", "  padded  "],
    ["a no-break space", "a\u00a0b"],
    ["an astral character", ASTRAL],
    ["YAML punctuation", "x, headers: {a: b} # c"],
  ])("takes %s", (_label, value) => {
    expect(VariableValueSchema.parse(value)).toBe(value);
  });
});

describe("the name's rule: UPPER_CASE on requests, the server's grammar in replies", () => {
  it.each(["otlp_endpoint", "Otlp", "_PRIVATE", "1ST", "A-B", "A B", "ÉTÉ"])("refuses %s on a create and a rename", (name) => {
    expect(CreateOrganizationVariableRequestSchema.safeParse({ id: ID, name, value: "v", description: null }).success).toBe(false);
    expect(UpdateOrganizationVariableRequestSchema.safeParse({ name }).success).toBe(false);
  });

  it.each(["A", "OTLP_ENDPOINT", "A1_2", nameOf(128)])("takes %s on a create and a rename", (name) => {
    expect(CreateOrganizationVariableRequestSchema.safeParse({ id: ID, name, value: "v", description: null }).success).toBe(true);
    expect(UpdateOrganizationVariableRequestSchema.safeParse({ name }).success).toBe(true);
  });

  it.each(["otlp_endpoint", "Otlp", "_PRIVATE", "_", nameOf(128, false)])("takes a reply's lowercase or underscore name %s, as the server does", (name) => {
    expect(OrganizationVariableSchema.parse({ ...variable, name })).toEqual({ ...variable, name });
    expect(VariablesUndefinedDetailsSchema.safeParse({ names: [name], totalNames: 1 }).success).toBe(true);
  });

  it.each(["1ST", "A-B", "ÉTÉ", "", nameOf(129, false)])("refuses a reply's name %s, outside the server's grammar", (name) => {
    expect(OrganizationVariableSchema.safeParse({ ...variable, name }).success).toBe(false);
    expect(VariablesUndefinedDetailsSchema.safeParse({ names: [name], totalNames: 1 }).success).toBe(false);
  });
});

describe("the requests", () => {
  it("takes a variable's create with its id, an empty value and no description; refuses one without an id or with another field", () => {
    const create = { id: ID, name: "REGION", value: "", description: null };
    expect(CreateOrganizationVariableRequestSchema.parse(create)).toEqual(create);
    const { id: _id, ...withoutId } = create;
    expect(CreateOrganizationVariableRequestSchema.safeParse(withoutId).success).toBe(false);
    const { description: _description, ...withoutDescription } = create;
    expect(CreateOrganizationVariableRequestSchema.safeParse(withoutDescription).success).toBe(false);
    expect(CreateOrganizationVariableRequestSchema.safeParse({ ...create, secret: true }).success).toBe(false);
    expect(CreateOrganizationVariableRequestSchema.safeParse({ ...create, id: "not-a-uuid" }).success).toBe(false);
  });

  it("takes an update of at least one field, a null description among them", () => {
    expect(UpdateOrganizationVariableRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateOrganizationVariableRequestSchema.parse({ description: null })).toEqual({ description: null });
    expect(UpdateOrganizationVariableRequestSchema.parse({ value: "" })).toEqual({ value: "" });
    expect(UpdateOrganizationVariableRequestSchema.safeParse({ value: "x", actor: ACTOR }).success).toBe(false);
  });

  it("takes a variable group's create and update, and an override of its value", () => {
    expect(CreateVariableGroupRequestSchema.parse({ id: ID, name: "eu-edge", description: "Europe" })).toEqual({
      id: ID,
      name: "eu-edge",
      description: "Europe",
    });
    expect(CreateVariableGroupRequestSchema.safeParse({ id: ID, name: "eu-edge" }).success).toBe(false);
    expect(UpdateVariableGroupRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateVariableGroupRequestSchema.parse({ name: "eu-west" })).toEqual({ name: "eu-west" });
    expect(UpdateVariableGroupRequestSchema.safeParse({ overrideCount: 1 }).success).toBe(false);
    expect(VariableGroupOverrideRequestSchema.parse({ value: "" })).toEqual({ value: "" });
    expect(VariableGroupOverrideRequestSchema.safeParse({ value: null }).success).toBe(false);
  });
});

describe("the replies", () => {
  it("answers a variable with its value, who changed it and when; nothing else", () => {
    expect(OrganizationVariableSchema.parse(variable)).toEqual(variable);
    expect(OrganizationVariableSchema.parse({ ...variable, changedBy: null, description: null })).toMatchObject({ changedBy: null });
    expect(OrganizationVariableSchema.safeParse({ ...variable, secret: false }).success).toBe(false);
    expect(OrganizationVariableSchema.safeParse({ ...variable, changedBy: { id: ID, email: "sam@acme.io" } }).success).toBe(false);
    const { changedAt: _changedAt, ...withoutChangedAt } = variable;
    expect(OrganizationVariableSchema.safeParse(withoutChangedAt).success).toBe(false);
  });

  it("lists at most 150 variables and 100 variable groups", () => {
    expect(ORGANIZATION_VARIABLES_MAXIMUM).toBe(150);
    expect(VARIABLE_GROUPS_MAXIMUM).toBe(100);
    expect(OrganizationVariablesResponseSchema.safeParse({ variables: Array.from({ length: 150 }, () => variable) }).success).toBe(true);
    expect(OrganizationVariablesResponseSchema.safeParse({ variables: Array.from({ length: 151 }, () => variable) }).success).toBe(false);
    expect(VariableGroupsResponseSchema.safeParse({ variableGroups: Array.from({ length: 100 }, () => variableGroup) }).success).toBe(true);
    expect(VariableGroupsResponseSchema.safeParse({ variableGroups: Array.from({ length: 101 }, () => variableGroup) }).success).toBe(false);
  });

  it("answers a variable group with its counts, and its detail with its overrides", () => {
    expect(VariableGroupSchema.parse(variableGroup)).toEqual(variableGroup);
    expect(VariableGroupSchema.safeParse({ ...variableGroup, overrideCount: 151 }).success).toBe(false);
    expect(VariableGroupSchema.safeParse({ ...variableGroup, usage: { collectorGroups: 1 } }).success).toBe(false);
    const override = { variableId: ID, value: "eu:4317", changedBy: ACTOR, changedAt: NOW };
    const detail = { variableGroup, overrides: [override] };
    expect(VariableGroupDetailSchema.parse(detail)).toEqual(detail);
    expect(VariableGroupDetailSchema.safeParse({ ...detail, overrides: [{ ...override, value: null }] }).success).toBe(false);
    expect(VariableGroupDetailSchema.safeParse({ variableGroup }).success).toBe(false);
    expect(VariableGroupDetailSchema.safeParse({ variableGroup, overrides: Array.from({ length: 150 }, () => override) }).success).toBe(true);
    expect(VariableGroupDetailSchema.safeParse({ variableGroup, overrides: Array.from({ length: 151 }, () => override) }).success).toBe(false);
  });
});

describe("the refusals' details", () => {
  const group = { fleetId: ID, fleetLabel: "edge-prod", groupId: ID, groupName: "gateways" };
  const use = {
    publishedVersionId: ID,
    configurationId: ID,
    configurationName: "edge-config",
    versionId: ID,
    versionNumber: 3,
    groups: [group],
    pinnedCollectors: 2,
  };

  it("takes every name the platform looks up as null, the totals kept", () => {
    const unnamed = {
      usedBy: [{ ...use, configurationId: null, configurationName: null, versionId: null, versionNumber: null, groups: [{ ...group, fleetLabel: null, groupName: null }] }],
      totalPublications: 7,
      totalGroups: 120,
      totalPinnedCollectors: 0,
    };
    expect(VariableInUseDetailsSchema.parse(unnamed)).toEqual(unnamed);
    const groupInUse = { collectorGroups: [{ ...group, groupName: null }], totalCollectorGroups: 250, pinnedCollectors: 4 };
    expect(VariableGroupInUseDetailsSchema.parse(groupInUse)).toEqual(groupInUse);
  });

  it("lists at most 100 entries, whatever the totals", () => {
    const hundred = Array.from({ length: 100 }, () => group);
    expect(VariableInUseDetailsSchema.safeParse({ usedBy: [{ ...use, groups: hundred }], totalPublications: 1, totalGroups: 100, totalPinnedCollectors: 2 }).success).toBe(true);
    expect(VariableInUseDetailsSchema.safeParse({ usedBy: [{ ...use, groups: [...hundred, group] }], totalPublications: 1, totalGroups: 101, totalPinnedCollectors: 2 }).success).toBe(false);
    expect(VariableInUseDetailsSchema.safeParse({ usedBy: Array.from({ length: 101 }, () => use), totalPublications: 101, totalGroups: 101, totalPinnedCollectors: 0 }).success).toBe(false);
    expect(VariableGroupInUseDetailsSchema.safeParse({ collectorGroups: [...hundred, group], totalCollectorGroups: 101, pinnedCollectors: 0 }).success).toBe(false);
    const names = Array.from({ length: 100 }, (_, index) => `NAME_${index}`);
    expect(VariablesUndefinedDetailsSchema.safeParse({ names, totalNames: 250 }).success).toBe(true);
    expect(VariablesUndefinedDetailsSchema.safeParse({ names: [...names, "ONE_MORE"], totalNames: 250 }).success).toBe(false);
  });

  it("refuses a field it doesn't name, and a negative total", () => {
    expect(VariableInUseDetailsSchema.safeParse({ usedBy: [{ ...use, publicationId: ID }], totalPublications: 1, totalGroups: 1, totalPinnedCollectors: 2 }).success).toBe(false);
    expect(VariablesUndefinedDetailsSchema.safeParse({ names: [], totalNames: -1 }).success).toBe(false);
  });
});

describe("VARIABLE_ERROR_CODES", () => {
  it("is the opamp-server's variables codes and the platform's unavailable", () => {
    expect(VARIABLE_ERROR_CODES).toEqual([
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
    ]);
  });

  it("words variables_unavailable neutrally, one family for a read, a write and a test run", () => {
    expect(VARIABLES_UNAVAILABLE_MESSAGE).toBe("The organization's variables couldn't be reached. Try again.");
    expect(VARIABLES_UNAVAILABLE_RUN_MESSAGE).toBe("The organization's variables couldn't be reached. Run it again.");
    for (const message of [VARIABLES_UNAVAILABLE_MESSAGE, VARIABLES_UNAVAILABLE_RUN_MESSAGE]) {
      expect(message.startsWith("The organization's variables couldn't be reached.")).toBe(true);
      expect(message).not.toMatch(/change|made|saved/);
    }
  });

  it("shares no code with another module's", () => {
    const others = new Set<string>([
      ...FLEET_ERROR_CODES,
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
    for (const code of VARIABLE_ERROR_CODES) expect(others.has(code), code).toBe(false);
  });
});
