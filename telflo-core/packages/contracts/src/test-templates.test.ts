import { describe, expect, it } from "vitest";
import {
  CreateTestTemplateFieldsSchema,
  TEST_TEMPLATE_DESCRIPTION_MAXIMUM_LENGTH,
  TEST_TEMPLATE_NAME_MAXIMUM_LENGTH,
  TEST_TEMPLATE_PART_NAMES,
  TEST_TEMPLATE_RECEIVER_TYPES,
  TEST_TEMPLATES_LIST_MAXIMUM,
  TestTemplateResponseSchema,
  TestTemplateSchema,
  TestTemplatesResponseSchema,
  UpdateTestTemplateRequestSchema,
} from "./test-templates.js";

const TEMPLATE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70";

describe("the limits and lists", () => {
  it("are migration 029's bounds, the list's 1,000 and the upload's parts, in order", () => {
    expect(TEST_TEMPLATE_NAME_MAXIMUM_LENGTH).toBe(200);
    expect(TEST_TEMPLATE_DESCRIPTION_MAXIMUM_LENGTH).toBe(2_000);
    expect(TEST_TEMPLATES_LIST_MAXIMUM).toBe(1_000);
    expect(TEST_TEMPLATE_PART_NAMES).toEqual(["name", "description", "receiverType", "signal", "file"]);
  });

  it("offers the palette's 18 receivers, each once, each as the table's check allows (the web checks the order)", () => {
    expect(TEST_TEMPLATE_RECEIVER_TYPES).toHaveLength(18);
    expect(new Set(TEST_TEMPLATE_RECEIVER_TYPES).size).toBe(18);
    for (const receiverType of TEST_TEMPLATE_RECEIVER_TYPES) {
      expect(receiverType).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
  });
});

describe("a template's fields", () => {
  const valid = { name: "OTLP trace sample", description: "", receiverType: "otlp", signal: "traces" };

  it("accepts the upload's text parts, trimming the name and the description", () => {
    expect(CreateTestTemplateFieldsSchema.parse(valid)).toEqual(valid);
    expect(CreateTestTemplateFieldsSchema.parse({ ...valid, name: "  Syslog  ", description: " RFC 5424 " })).toEqual({
      ...valid,
      name: "Syslog",
      description: "RFC 5424",
    });
    for (const receiverType of TEST_TEMPLATE_RECEIVER_TYPES) {
      expect(CreateTestTemplateFieldsSchema.safeParse({ ...valid, receiverType }).success).toBe(true);
    }
  });

  it.each<[string, Record<string, unknown>]>([
    ["a blank name", { name: "  " }],
    ["a 201-character name", { name: "n".repeat(201) }],
    ["a name with U+0000", { name: "a\u0000" }],
    ["a 2,001-character description", { description: "d".repeat(2_001) }],
    ["no description (the part is always sent)", { description: undefined }],
    ["a receiver type not in the list", { receiverType: "kafka" }],
    ["a receiver type in another case", { receiverType: "OTLP" }],
    ["a palette label in place of the type", { receiverType: "File Log" }],
    ["an unknown signal", { signal: "profiles" }],
    ["an unknown field", { fileName: "a.json" }],
  ])("refuses %s", (_label, overrides) => {
    expect(CreateTestTemplateFieldsSchema.safeParse({ ...valid, ...overrides }).success).toBe(false);
  });

  it("updates any of the metadata, the rest left as it is", () => {
    expect(UpdateTestTemplateRequestSchema.parse({ name: " Renamed " })).toEqual({ name: "Renamed" });
    expect(UpdateTestTemplateRequestSchema.parse({ receiverType: "syslog", signal: "logs" })).toEqual({
      receiverType: "syslog",
      signal: "logs",
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["a blank name", { name: "" }],
    ["a 2,001-character description", { description: "d".repeat(2_001) }],
    ["a receiver type not in the list", { receiverType: "kafka" }],
    ["an unknown signal", { signal: "profiles" }],
    ["the file's name (the file never changes)", { fileName: "b.json" }],
    ["the file", { file: "x" }],
  ])("refuses an update with %s", (_label, body) => {
    expect(UpdateTestTemplateRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("the responses", () => {
  const template = {
    id: TEMPLATE_ID,
    name: "OTLP trace sample",
    description: "",
    receiverType: "otlp",
    signal: "traces",
    fileName: "otlp-traces.json",
    contentType: "application/json",
    sizeBytes: 1_024,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
  };

  it("carry a template, alone and in a list", () => {
    expect(TestTemplateResponseSchema.parse({ template })).toEqual({ template });
    expect(TestTemplatesResponseSchema.parse({ templates: [template] })).toEqual({ templates: [template] });
    // A stored receiver type the list no longer offers still serialises.
    expect(TestTemplateSchema.safeParse({ ...template, receiverType: "kafka" }).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a receiver type the table would refuse", { receiverType: "Kafka" }],
    ["a name over its bound", { name: "n".repeat(201) }],
    ["a file name over its bound", { fileName: "f".repeat(256) }],
    ["a size over 10 MiB", { sizeBytes: 10_485_761 }],
    ["an unknown field", { deletedAt: null }],
  ])("refuse a template with %s", (_label, overrides) => {
    expect(TestTemplateSchema.safeParse({ ...template, ...overrides }).success).toBe(false);
  });
});
