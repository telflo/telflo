import { describe, expect, it } from "vitest";
import { issuePathOf } from "./issue-path.js";

describe("issuePathOf", () => {
  it("reads a Zod issue's own path", () => {
    expect(issuePathOf({ path: ["ottl", "condition"], message: "Required" })).toBe("ottl.condition");
    expect(issuePathOf({ path: ["items", 2] })).toBe("items.2");
  });

  it("reads the envelope's params.issue path (fastify-type-provider-zod's, and the fleet routes' details)", () => {
    expect(
      issuePathOf({
        keyword: "custom",
        instancePath: "/label",
        schemaPath: "#/label/custom",
        params: { issue: { code: "custom", path: ["label"], message: "Must be 1 to 80 characters." } },
        message: "Must be 1 to 80 characters.",
      }),
    ).toBe("label");
  });

  it("falls back to the JSON pointer", () => {
    expect(issuePathOf({ instancePath: "/rotateExpiresAt", message: "Invalid datetime" })).toBe("rotateExpiresAt");
    expect(issuePathOf({ instancePath: "/ottl/condition" })).toBe("ottl.condition");
  });

  it("is undefined when it names no path", () => {
    expect(issuePathOf({ message: "The request was not valid." })).toBeUndefined();
    expect(issuePathOf({ path: [] })).toBeUndefined();
    expect(issuePathOf({ instancePath: "" })).toBeUndefined();
    expect(issuePathOf({ path: [{ nested: true }] })).toBeUndefined();
  });
});
