import { describe, expect, it } from "vitest";
import {
  PublicCreateConfigurationRequestSchema,
  PublicCreateConfigurationVersionRequestSchema,
  PublicListConfigurationsQuerySchema,
  PublicUpdateConfigurationRequestSchema,
  PublicUpdateConfigurationVersionQuerySchema,
  PublicUpdateConfigurationVersionRequestSchema,
  PublicVersionNumberSchema,
} from "./configurations.js";

/*
 * The public configurations' request shapes (D25 decisions 18, 19 and 31;
 * Preflight rulings 6 and 16): a version's number written plainly, the
 * platform's limits, merge-patch nulls, and strict bodies.
 */

describe("the public configurations' requests", () => {
  it("a version number is a plain positive integer of at most nine digits", () => {
    expect(PublicVersionNumberSchema.parse("1")).toBe(1);
    expect(PublicVersionNumberSchema.parse("999999999")).toBe(999_999_999);
    for (const refused of ["0", "07", "1e2", "-1", "+1", "1.0", " 1", "1234567890", "", "0x1"]) {
      expect(PublicVersionNumberSchema.safeParse(refused).success).toBe(false);
    }
  });

  it("a create takes a name, the YAML and a distribution, nothing else, within the platform's limits", () => {
    expect(PublicCreateConfigurationRequestSchema.parse({ name: "  Gateway ", yaml: "" })).toEqual({ name: "Gateway", yaml: "" });
    expect(
      PublicCreateConfigurationRequestSchema.parse({ name: "G", yaml: "a: 1\n", distribution: "otelcol-contrib" }),
    ).toEqual({ name: "G", yaml: "a: 1\n", distribution: "otelcol-contrib" });
    for (const refused of [
      { name: "", yaml: "" },
      { name: "G" },
      { name: "G", yaml: "a".repeat(262_145) },
      { name: "G", yaml: "\u0000" },
      { name: "G", yaml: "", description: "d" },
      { name: "G", yaml: "", collector_distribution: "otelcol-contrib" },
      { name: "G", yaml: "", distribution: "Not A Distribution" },
    ]) {
      expect(PublicCreateConfigurationRequestSchema.safeParse(refused).success).toBe(false);
    }
    expect(PublicCreateConfigurationRequestSchema.safeParse({ name: "G", yaml: "a".repeat(262_144) }).success).toBe(true);
  });

  it("a configuration's PATCH clears the description with null, keeps the 500 maximum, and refuses a YAML", () => {
    expect(PublicUpdateConfigurationRequestSchema.parse({ description: null })).toEqual({ description: "" });
    expect(PublicUpdateConfigurationRequestSchema.parse({})).toEqual({});
    expect(PublicUpdateConfigurationRequestSchema.parse({ name: " N ", description: " D " })).toEqual({ name: "N", description: "D" });
    for (const refused of [{ name: null }, { name: "" }, { description: "d".repeat(501) }, { yaml: "" }]) {
      expect(PublicUpdateConfigurationRequestSchema.safeParse(refused).success).toBe(false);
    }
  });

  it("a version's append takes the YAML and a label of 1 to 80 characters, or none", () => {
    expect(PublicCreateConfigurationVersionRequestSchema.parse({ yaml: "" })).toEqual({ yaml: "" });
    expect(PublicCreateConfigurationVersionRequestSchema.parse({ yaml: "", label: null })).toEqual({ yaml: "", label: null });
    expect(PublicCreateConfigurationVersionRequestSchema.parse({ yaml: "", label: " v2 " })).toEqual({ yaml: "", label: "v2" });
    for (const refused of [{ label: "x" }, { yaml: "", label: "" }, { yaml: "", label: "l".repeat(81) }, { yaml: "", description: "d" }]) {
      expect(PublicCreateConfigurationVersionRequestSchema.safeParse(refused).success).toBe(false);
    }
  });

  it("a version's PATCH merges the YAML and the collector version, neither nullable, nothing else", () => {
    expect(PublicUpdateConfigurationVersionRequestSchema.parse({})).toEqual({});
    expect(PublicUpdateConfigurationVersionRequestSchema.parse({ yaml: "a: 1\n", collectorVersion: "0.162.0" })).toEqual({
      yaml: "a: 1\n",
      collectorVersion: "0.162.0",
    });
    for (const refused of [{ yaml: null }, { collectorVersion: null }, { collectorVersion: "latest" }, { distribution: "x" }, { validate: true }]) {
      expect(PublicUpdateConfigurationVersionRequestSchema.safeParse(refused).success).toBe(false);
    }
    expect(PublicUpdateConfigurationVersionQuerySchema.parse({})).toEqual({ validate: false });
    expect(PublicUpdateConfigurationVersionQuerySchema.parse({ validate: "true" })).toEqual({ validate: true });
    expect(PublicUpdateConfigurationVersionQuerySchema.parse({ validate: "false" })).toEqual({ validate: false });
    expect(PublicUpdateConfigurationVersionQuerySchema.safeParse({ validate: "1" }).success).toBe(false);
  });

  it("the list takes the browser list's limit and cursor only", () => {
    expect(PublicListConfigurationsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(PublicListConfigurationsQuerySchema.parse({ limit: "2", cursor: "c" })).toEqual({ limit: 2, cursor: "c" });
    for (const refused of [{ limit: "0" }, { limit: "101" }, { q: "x" }, { filter: "mine" }]) {
      expect(PublicListConfigurationsQuerySchema.safeParse(refused).success).toBe(false);
    }
  });
});
