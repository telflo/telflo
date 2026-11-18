import { describe, expect, it } from "vitest";
import {
  COLLECTOR_COMPONENT_KINDS,
  COLLECTOR_COMPONENT_SECTIONS,
  CollectorDistributionIdSchema,
  CollectorDistributionsResponseSchema,
  CollectorRenamedTypeSchema,
  CollectorVersionNumberSchema,
} from "./collector-distributions.js";

const offer = {
  version: "0.162.0",
  label: "v0.162.0",
  description: "Current default.",
  releasedAt: "2026-09-29",
  isDefault: true,
  supportedComponents: null,
};

const rename = { kind: "receiver", name: "file_log", deprecatedName: "filelog", since: "0.149.0" };

const distribution = {
  id: "otelcol-contrib",
  label: "OpenTelemetry Collector Contrib",
  description: "The full upstream component catalog.",
  icon: "otel",
  isDefault: true,
  versions: [offer, { ...offer, version: "0.161.0", label: "v0.161.0", description: null, isDefault: false }],
  renamedTypes: [rename, { kind: "exporter", name: "otlp_grpc", deprecatedName: "otlp", since: "0.144.0" }],
};

const SUPPORTED = {
  receivers: ["otlp"],
  processors: ["batch"],
  exporters: ["otlphttp"],
  connectors: [],
  extensions: ["health_check"],
};

describe("CollectorDistributionsResponseSchema (D13a decision 11, Ruling 26)", () => {
  it("accepts { distributions }, each with its versions", () => {
    const response = { distributions: [distribution] };
    expect(CollectorDistributionsResponseSchema.parse(response)).toEqual(response);
    expect(CollectorDistributionsResponseSchema.safeParse({ distributions: [] }).success).toBe(true);
  });

  it("accepts a distribution with no description or icon, no renames, and a version's components by section", () => {
    const fixture = {
      ...distribution,
      id: "fixture-build",
      description: null,
      icon: null,
      isDefault: false,
      versions: [{ ...offer, supportedComponents: SUPPORTED }],
      renamedTypes: [],
    };
    expect(CollectorDistributionsResponseSchema.safeParse({ distributions: [fixture] }).success).toBe(true);
  });

  it("names the five sections of a supported-components list", () => {
    expect(COLLECTOR_COMPONENT_SECTIONS).toEqual(["receivers", "processors", "exporters", "connectors", "extensions"]);
  });

  it.each([
    ["a missing section", { ...SUPPORTED, connectors: undefined }],
    ["an unknown section", { ...SUPPORTED, pipelines: [] }],
    ["a section that isn't a list", { ...SUPPORTED, receivers: "otlp" }],
  ])("refuses supported components with %s", (_label, supportedComponents) => {
    const versions = [{ ...offer, supportedComponents }];
    expect(CollectorDistributionsResponseSchema.safeParse({ distributions: [{ ...distribution, versions }] }).success).toBe(
      false,
    );
  });

  it("refuses a release day that isn't YYYY-MM-DD, and a timestamp", () => {
    for (const releasedAt of ["29/09/2026", "2026-09-29T00:00:00.000Z", "2026-02-30"]) {
      const versions = [{ ...offer, releasedAt }];
      expect(
        CollectorDistributionsResponseSchema.safeParse({ distributions: [{ ...distribution, versions }] }).success,
      ).toBe(false);
    }
  });

  it("refuses unknown fields at every level: a version's binaries and deprecation never leave the server", () => {
    expect(CollectorDistributionsResponseSchema.safeParse({ distributions: [], total: 1 }).success).toBe(false);
    expect(
      CollectorDistributionsResponseSchema.safeParse({ distributions: [{ ...distribution, sortOrder: 0 }] }).success,
    ).toBe(false);
    for (const extra of [{ deprecated: false }, { deprecatedNote: null }, { containerImage: "otel/x:1" }, { otelcolContrib: {} }]) {
      const versions = [{ ...offer, ...extra }];
      expect(
        CollectorDistributionsResponseSchema.safeParse({ distributions: [{ ...distribution, versions }] }).success,
      ).toBe(false);
    }
  });

  it("refuses a missing field", () => {
    for (const field of ["id", "label", "description", "icon", "isDefault", "versions", "renamedTypes"] as const) {
      const { [field]: _dropped, ...without } = distribution;
      expect(CollectorDistributionsResponseSchema.safeParse({ distributions: [without] }).success).toBe(false);
    }
    for (const field of ["version", "label", "description", "releasedAt", "isDefault", "supportedComponents"] as const) {
      const { [field]: _dropped, ...without } = offer;
      expect(
        CollectorDistributionsResponseSchema.safeParse({ distributions: [{ ...distribution, versions: [without] }] })
          .success,
      ).toBe(false);
    }
  });
});

describe("a distribution's renamed types (D13b decision 6, Preflight ruling 16)", () => {
  const withRenames = (renamedTypes: unknown[]) =>
    CollectorDistributionsResponseSchema.safeParse({ distributions: [{ ...distribution, renamedTypes }] }).success;

  it("names the five kinds, singular", () => {
    expect(COLLECTOR_COMPONENT_KINDS).toEqual(["receiver", "processor", "exporter", "connector", "extension"]);
  });

  it("accepts each kind, and a name at 64 characters", () => {
    for (const kind of COLLECTOR_COMPONENT_KINDS) {
      expect(CollectorRenamedTypeSchema.safeParse({ ...rename, kind }).success).toBe(true);
    }
    expect(CollectorRenamedTypeSchema.safeParse({ ...rename, name: `a${"_".repeat(63)}` }).success).toBe(true);
  });

  it.each([
    ["a plural kind", { ...rename, kind: "receivers" }],
    ["an unknown kind", { ...rename, kind: "pipeline" }],
    ["a name with a capital", { ...rename, name: "File_log" }],
    ["a name starting with a digit", { ...rename, name: "1file" }],
    ["a name with a hyphen", { ...rename, deprecatedName: "file-log" }],
    ["an empty name", { ...rename, deprecatedName: "" }],
    ["a name over 64 characters", { ...rename, name: `a${"b".repeat(64)}` }],
    ["a since that isn't major.minor.patch", { ...rename, since: "v0.149.0" }],
    ["an unknown field", { ...rename, note: "x" }],
    ["a missing since", { kind: "receiver", name: "file_log", deprecatedName: "filelog" }],
  ])("refuses %s", (_label, entry) => {
    expect(withRenames([entry])).toBe(false);
  });
});

describe("the request formats (D13a Preflight ruling 5)", () => {
  it("takes a distribution id as lowercase words joined by hyphens, at most 64 characters", () => {
    for (const id of ["otelcol-contrib", "clickstack", "a1-b2-c3", "a".repeat(64)]) {
      expect(CollectorDistributionIdSchema.safeParse(id).success).toBe(true);
    }
    for (const id of ["", "-otelcol", "otelcol--contrib", "Otelcol", "otelcol_contrib", "a".repeat(65)]) {
      expect(CollectorDistributionIdSchema.safeParse(id).success).toBe(false);
    }
  });

  it("takes a collector version as major.minor.patch in ASCII digits, at most 64 characters", () => {
    for (const version of ["0.162.0", "1.0.0", "10.200.3000"]) {
      expect(CollectorVersionNumberSchema.safeParse(version).success).toBe(true);
    }
    for (const version of ["", "0.162", "v0.162.0", "0.162.0 ", "0.162.0-rc.1", "0.1.2.3", "٠.١.٢"]) {
      expect(CollectorVersionNumberSchema.safeParse(version).success).toBe(false);
    }
  });
});
