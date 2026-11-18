import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  collectorGroupSchema,
  collectorInstanceBulkPinResultSchema,
  collectorInstanceErrorListSchema,
  collectorInstanceListSchema,
  collectorInstanceSchema,
  configurationUsageSchema,
  enrollmentTokenListSchema,
  enrollmentTokenRevealedSchema,
  enrollmentTokenRotatedSchema,
  enrollmentTokenSchema,
  errorEnvelopeSchema,
  fleetCreatedSchema,
  fleetDetailSchema,
  fleetListSchema,
  fleetSchema,
  fleetSummarySchema,
  fleetUnchangedSchema,
  NAME_PATTERN,
  NAME_PATTERN_SOURCE,
  OPAMP_SERVER_ERROR_CODES,
  organizationLimitsSchema,
  VARIABLE_NAME_PATTERN_SOURCE,
  VARIABLE_VALUE_PATTERN_SOURCE,
  variableGroupDetailSchema,
  variableGroupInUseDetailsSchema,
  variableGroupListSchema,
  variableGroupOverrideSchema,
  variableGroupSchema,
  variableInUseDetailsSchema,
  variableListSchema,
  variableSchema,
  variablesUndefinedDetailsSchema,
} from "./schemas.js";

// D16a Ruling 58: the platform's list of the opamp-server's error codes is
// the contract's, read from vendor/opamp-server/openapi.yaml as the
// fake reads it: a code the server adds without the platform learning it
// fails the platform's envelope parse (and so its call) instead of being
// answered.
const OPENAPI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../vendor/opamp-server/openapi.yaml",
);

interface ErrorSchema {
  properties: { error: { properties: { code: { enum: string[] } } } };
}

interface ContractSchema {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  required?: string[];
  properties?: Record<string, ContractSchema>;
  items?: ContractSchema;
}

function contractSchemas(): Record<string, ContractSchema> & { Error: ErrorSchema } {
  const document = parseYaml(readFileSync(OPENAPI_PATH, "utf8")) as {
    components: { schemas: Record<string, ContractSchema> & { Error: ErrorSchema } };
  };
  return document.components.schemas;
}

function contractErrorCodes(): string[] {
  return contractSchemas().Error.properties.error.properties.code.enum;
}

describe("OPAMP_SERVER_ERROR_CODES", () => {
  it("is exactly openapi.yaml's error-code enum", () => {
    const contract = contractErrorCodes();
    expect(contract.length).toBeGreaterThan(0);
    expect([...OPAMP_SERVER_ERROR_CODES].sort()).toEqual([...contract].sort());
    expect(new Set(OPAMP_SERVER_ERROR_CODES).size).toBe(OPAMP_SERVER_ERROR_CODES.length);
  });

  it("lets the envelope parse every contract code, the fleet model's among them", () => {
    for (const code of contractErrorCodes()) {
      expect(errorEnvelopeSchema.safeParse({ error: { code, message: "m" } }).success).toBe(true);
    }
    expect(errorEnvelopeSchema.safeParse({ error: { code: "not_a_code", message: "m" } }).success).toBe(false);
  });
});

// D16b Preflight ruling 3: the fleet model's mirrors keep the file's names,
// patterns and bounds.
describe("NAME_PATTERN", () => {
  it.each(["FleetLabel", "CollectorGroupName", "CollectorInstanceName"])("is exactly openapi.yaml's %s pattern, read with the u flag", (name) => {
    const pattern = contractSchemas()[name]?.pattern;

    expect(pattern).toBeDefined();
    expect(NAME_PATTERN_SOURCE).toBe(pattern);
    expect(NAME_PATTERN.source).toBe(new RegExp(pattern as string, "u").source);
    expect(NAME_PATTERN.flags).toBe("u");
  });

  it.each([
    ["a plain label", "edge-prod", true],
    ["one character", "x", true],
    ["inner spaces and an emoji", "edge prod 🚀", true],
    ["a leading space", " edge", false],
    ["a trailing no-break space", "edge\u00a0", false],
    ["a trailing ideographic space", "edge\u3000", false],
    ["a leading line separator", "\u2028edge", false],
    ["a tab inside", "edge\tprod", false],
    ["a C1 control inside", "edge\u0085prod", false],
    ["U+0000", "edge\u0000", false],
    ["an emoji alone, one code point", "🚀", true],
  ])("reads %s as the contract does", (_label, value, valid) => {
    expect(NAME_PATTERN.test(value)).toBe(valid);
  });

  it("bounds a fleet's label to 80 code points, not UTF-16 units", () => {
    const fleet = {
      id: "5d6c7b8a-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      organizationId: "5d6c7b8a-9e0f-4a1b-8c2d-3e4f5a6b7c8e",
      label: "🚀".repeat(80),
      type: "server",
      status: "active",
      createdBy: null,
      createdAt: "2026-10-13T09:00:00.000Z",
      updatedAt: "2026-10-13T09:00:00.000Z",
    };

    expect(fleetSchema.safeParse(fleet).success).toBe(true);
    expect(fleetSchema.safeParse({ ...fleet, label: "🚀".repeat(81) }).success).toBe(false);
  });
});

/** The keys of a zod object, through any nullable wrapper. */
function keysOf(schema: z.ZodTypeAny): string[] {
  const inner = schema instanceof z.ZodNullable ? (schema.unwrap() as z.ZodTypeAny) : schema;
  if (!(inner instanceof z.ZodObject)) throw new Error("not an object schema");
  return Object.keys(inner.shape as Record<string, unknown>).sort();
}

describe("the fleet model's mirrors", () => {
  it.each([
    ["Fleet", fleetSchema],
    ["FleetDetail", fleetDetailSchema],
    ["FleetSummary", fleetSummarySchema],
    ["FleetRotateToken", fleetSummarySchema.shape.rotateToken],
    ["FleetList", fleetListSchema],
    ["FleetUnchanged", fleetUnchangedSchema],
    ["FleetCreated", fleetCreatedSchema],
    ["CollectorGroup", collectorGroupSchema],
    ["EnrollmentToken", enrollmentTokenSchema],
    ["EnrollmentTokenList", enrollmentTokenListSchema],
    ["EnrollmentTokenRotated", enrollmentTokenRotatedSchema],
    ["EnrollmentTokenRevealed", enrollmentTokenRevealedSchema],
    ["CollectorInstance", collectorInstanceSchema],
    ["CollectorInstanceList", collectorInstanceListSchema],
    ["CollectorInstanceBulkPinResult", collectorInstanceBulkPinResultSchema],
    ["CollectorInstanceErrorList", collectorInstanceErrorListSchema],
    ["OrganizationLimits", organizationLimitsSchema],
    ["ConfigurationUsage", configurationUsageSchema],
    // D20 (Task 9).
    ["Variable", variableSchema],
    ["VariableList", variableListSchema],
    ["VariableGroup", variableGroupSchema],
    ["VariableGroupList", variableGroupListSchema],
    ["VariableGroupOverride", variableGroupOverrideSchema],
    ["VariableGroupDetail", variableGroupDetailSchema],
    ["VariableInUseDetails", variableInUseDetailsSchema],
    ["VariableGroupInUseDetails", variableGroupInUseDetailsSchema],
    ["VariablesUndefinedDetails", variablesUndefinedDetailsSchema],
  ] as const)("%s has exactly the file's fields, every one required", (name, schema) => {
    const contract = contractSchemas()[name];

    expect(contract?.properties).toBeDefined();
    expect(keysOf(schema)).toEqual(Object.keys(contract?.properties ?? {}).sort());
    expect([...(contract?.required ?? [])].sort()).toEqual(keysOf(schema));
  });

  it("keeps the file's bounds and no stricter: an unpaged list has no maximum", () => {
    const token = {
      id: "5d6c7b8a-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      fleetId: "5d6c7b8a-9e0f-4a1b-8c2d-3e4f5a6b7c8e",
      kind: "rotate",
      expiresAt: null,
      revokedAt: null,
      doRefresh: false,
      createdBy: null,
      createdAt: "2026-10-13T09:00:00.000Z",
      activeCollectors: 0,
    };

    expect(enrollmentTokenListSchema.safeParse({ tokens: Array.from({ length: 1000 }, () => token) }).success).toBe(true);
    expect(fleetListSchema.safeParse({ fleets: [], nextCursor: null }).success).toBe(true);
    expect(organizationLimitsSchema.safeParse({ maxCollectors: 0, requestsPerMinute: null }).success).toBe(true);
    expect(organizationLimitsSchema.safeParse({ maxCollectors: -1, requestsPerMinute: null }).success).toBe(false);
    expect(organizationLimitsSchema.safeParse({ maxCollectors: null, requestsPerMinute: 0 }).success).toBe(false);
  });

  it("strips a field the file doesn't name, rather than refusing it", () => {
    const limits = organizationLimitsSchema.parse({ maxCollectors: 5, requestsPerMinute: null, later: true });

    expect(limits).toEqual({ maxCollectors: 5, requestsPerMinute: null });
  });
});

// D20 (Task 9; Preflight rulings 1 and 23): the variables' mirrors keep the
// file's patterns and bounds, lengths in code points. The file writes
// U+2028 and U+2029 as YAML escapes, which its parser reads as the
// characters; the client's pattern writes them as regular-expression
// escapes, never the characters.
describe("the variables' mirrors", () => {
  const variable = {
    id: "5d6c7b8a-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
    name: "OTLP_ENDPOINT",
    value: "eu:4317",
    description: null,
    changedBy: null,
    changedAt: "2026-10-20T09:00:00.000Z",
  };
  const group = {
    id: "5d6c7b8a-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
    name: "eu-edge",
    description: null,
    overrideCount: 0,
    usage: { collectorGroups: 0, pinnedCollectors: 0 },
    changedBy: null,
    changedAt: "2026-10-20T09:00:00.000Z",
  };
  const LINE_SEPARATOR = String.fromCharCode(0x2028);
  const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

  it("names a variable with exactly openapi.yaml's VariableName pattern, 1 to 128 characters", () => {
    const contract = contractSchemas().VariableName;

    expect(VARIABLE_NAME_PATTERN_SOURCE).toBe(contract?.pattern);
    expect([contract?.minLength, contract?.maxLength]).toEqual([1, 128]);
    expect(variableSchema.safeParse({ ...variable, name: "otlp_endpoint" }).success).toBe(true);
    expect(variableSchema.safeParse({ ...variable, name: "_".repeat(128) }).success).toBe(true);
    expect(variableSchema.safeParse({ ...variable, name: "_".repeat(129) }).success).toBe(false);
    expect(variableSchema.safeParse({ ...variable, name: "1ST" }).success).toBe(false);
  });

  it("holds a value to exactly openapi.yaml's VariableValue pattern, its separators written as escapes, 0 to 1,024 code points (Q104)", () => {
    const contract = contractSchemas().VariableValue;
    const pattern = contract?.pattern ?? "";

    expect(pattern).toContain(LINE_SEPARATOR);
    expect(VARIABLE_VALUE_PATTERN_SOURCE).not.toContain(LINE_SEPARATOR);
    expect(VARIABLE_VALUE_PATTERN_SOURCE).not.toContain(PARAGRAPH_SEPARATOR);
    expect(VARIABLE_VALUE_PATTERN_SOURCE).toBe(pattern.replaceAll(LINE_SEPARATOR, "\\u2028").replaceAll(PARAGRAPH_SEPARATOR, "\\u2029"));
    expect(contract?.maxLength).toBe(1024);
    expect(variableSchema.safeParse({ ...variable, value: "" }).success).toBe(true);
    expect(variableSchema.safeParse({ ...variable, value: "\u{1F680}".repeat(1024) }).success).toBe(true);
    expect(variableSchema.safeParse({ ...variable, value: "\u{1F680}".repeat(1025) }).success).toBe(false);
    expect(variableSchema.safeParse({ ...variable, value: "a".repeat(1025) }).success).toBe(false);
    for (const refused of ["a\nb", "a\tb", "a\u0085b", "a\u007fb", `a${LINE_SEPARATOR}b`, `a${PARAGRAPH_SEPARATOR}b`]) {
      expect(variableSchema.safeParse({ ...variable, value: refused }).success).toBe(false);
      expect(new RegExp(pattern, "u").test(refused)).toBe(false);
    }
  });

  it.each([
    ["VariableDescription", 1000],
    ["VariableGroupName", 200],
  ])("holds %s to exactly NAME_PATTERN, at most %i code points", (name, maximum) => {
    const contract = contractSchemas()[name];

    expect(contract?.pattern).toBe(NAME_PATTERN_SOURCE);
    expect([contract?.minLength, contract?.maxLength]).toEqual([1, maximum]);
  });

  it("bounds a description to 1,000 and a variable group's name to 200 code points, each in NAME_PATTERN", () => {
    expect(variableSchema.safeParse({ ...variable, description: "\u{1F680}".repeat(1000) }).success).toBe(true);
    expect(variableSchema.safeParse({ ...variable, description: "\u{1F680}".repeat(1001) }).success).toBe(false);
    expect(variableSchema.safeParse({ ...variable, description: " padded" }).success).toBe(false);
    expect(variableGroupSchema.safeParse({ ...group, name: "\u{1F680}".repeat(200) }).success).toBe(true);
    expect(variableGroupSchema.safeParse({ ...group, name: "\u{1F680}".repeat(201) }).success).toBe(false);
    expect(variableGroupSchema.safeParse({ ...group, overrideCount: 151 }).success).toBe(false);
  });

  it("lists as the file bounds: 150 variables (Q104), 100 variable groups, 150 overrides, 100 details entries", () => {
    expect(variableListSchema.safeParse({ variables: Array.from({ length: 150 }, () => variable) }).success).toBe(true);
    expect(variableListSchema.safeParse({ variables: Array.from({ length: 151 }, () => variable) }).success).toBe(false);
    expect(variableGroupListSchema.safeParse({ variableGroups: Array.from({ length: 101 }, () => group) }).success).toBe(false);
    const override = { variableId: variable.id, value: "v", changedBy: null, changedAt: variable.changedAt };
    expect(variableGroupDetailSchema.safeParse({ variableGroup: group, overrides: Array.from({ length: 150 }, () => override) }).success).toBe(true);
    expect(variableGroupDetailSchema.safeParse({ variableGroup: group, overrides: Array.from({ length: 151 }, () => override) }).success).toBe(false);
    expect(variablesUndefinedDetailsSchema.safeParse({ names: Array.from({ length: 101 }, () => "A"), totalNames: 101 }).success).toBe(false);
    expect(variablesUndefinedDetailsSchema.safeParse({ names: Array.from({ length: 100 }, () => "A"), totalNames: 250 }).success).toBe(true);
  });
});
