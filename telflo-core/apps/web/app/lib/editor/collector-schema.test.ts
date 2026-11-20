// @vitest-environment node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  monacoYamlOptions,
  readSchemaCatalogue,
  SCHEMA_CATALOGUE,
  SCHEMA_DISTRIBUTIONS,
  schemaPathFor,
  type SchemaCatalogueVersion,
} from "./collector-schema.js";

/*
 * Which schema the pin gets, and the options monaco-yaml gets for it.
 */

const CATALOGUE: Record<string, readonly SchemaCatalogueVersion[]> = {
  "otelcol-contrib": [
    { version: "0.162.0", deprecated: false },
    { version: "0.161.0", deprecated: false },
    { version: "0.158.0", deprecated: true },
  ],
  "grafana-alloy": [{ version: "1.0.0", deprecated: false }],
};

describe("schemaPathFor", () => {
  it("gives an offered version of a distribution with schemas its file", () => {
    expect(schemaPathFor("otelcol-contrib", "0.162.0", CATALOGUE)).toBe("/schemas/otelcol-contrib/v0.162.0.json");
    expect(schemaPathFor("otelcol-contrib", "0.161.0", CATALOGUE)).toBe("/schemas/otelcol-contrib/v0.161.0.json");
  });

  it("gives syntax only (null) to a null pin or distribution", () => {
    expect(schemaPathFor("otelcol-contrib", null, CATALOGUE)).toBeNull();
    expect(schemaPathFor(null, "0.162.0", CATALOGUE)).toBeNull();
    expect(schemaPathFor(null, null, CATALOGUE)).toBeNull();
  });

  it("gives syntax only to a retired version", () => {
    expect(schemaPathFor("otelcol-contrib", "0.158.0", CATALOGUE)).toBeNull();
  });

  it("gives syntax only to a version the catalogue doesn't list", () => {
    expect(schemaPathFor("otelcol-contrib", "0.163.0", CATALOGUE)).toBeNull();
    expect(schemaPathFor("otelcol-contrib", "../../etc/passwd", CATALOGUE)).toBeNull();
  });

  it("gives syntax only to a distribution without schemas, even on a version it offers, and to one the catalogue doesn't have", () => {
    expect(schemaPathFor("grafana-alloy", "1.0.0", CATALOGUE)).toBeNull();
    expect(schemaPathFor("acme-collector", "0.162.0", CATALOGUE)).toBeNull();
    // An inherited property is no distribution.
    expect(schemaPathFor("constructor", "0.162.0", CATALOGUE)).toBeNull();
  });

  it("reads the real catalogue: each offered version of each distribution with schemas has its committed file, and a retired one gets none", () => {
    const contrib = SCHEMA_CATALOGUE["otelcol-contrib"] ?? [];
    const offered = contrib.filter((entry) => !entry.deprecated);
    const retired = contrib.filter((entry) => entry.deprecated);
    expect(offered.length).toBeGreaterThan(0);
    expect(retired.length).toBeGreaterThan(0);

    for (const distribution of SCHEMA_DISTRIBUTIONS) {
      for (const { version, deprecated } of SCHEMA_CATALOGUE[distribution] ?? []) {
        const path = schemaPathFor(distribution, version);
        if (deprecated) {
          expect(path).toBeNull();
          continue;
        }
        expect(path).toBe(`/schemas/${distribution}/v${version}.json`);
        expect(existsSync(fileURLToPath(new URL(`../../../public${path}`, import.meta.url)))).toBe(true);
      }
    }
  });

  it("refuses a catalogue without distribution files, or a file without a valid versions list, naming it", () => {
    expect(() => readSchemaCatalogue({})).toThrow("catalog/distributions/*.json matched nothing");
    expect(() => readSchemaCatalogue({ "/catalog/distributions/acme.json": [{ version: "1.0.0" }] })).toThrow(
      "acme.json has no valid versions list",
    );
    expect(() => readSchemaCatalogue({ "/catalog/distributions/acme.json": undefined })).toThrow(
      "acme.json has no valid versions list",
    );
    expect(readSchemaCatalogue({ "/catalog/distributions/acme.json": [{ version: "1.0.0", deprecated: false, extra: 1 }] })).toEqual({
      acme: [{ version: "1.0.0", deprecated: false }],
    });
  });
});

describe("monacoYamlOptions (the one source of monaco-yaml's options: the editor's and the schema tests')", () => {
  it("with a schema: completion and hover on, no schema source in hover, the schema inline for every model, no schema request", () => {
    const schema = { type: "object", properties: { receivers: { type: "object" } } } as const;

    expect(monacoYamlOptions({ uri: "http://localhost:53000/schemas/otelcol-contrib/v0.162.0.json", schema })).toEqual({
      validate: true,
      completion: true,
      hover: true,
      hoverSchemaSource: false,
      format: {},
      enableSchemaRequest: false,
      schemas: [{ uri: "http://localhost:53000/schemas/otelcol-contrib/v0.162.0.json", fileMatch: ["*"], schema }],
    });
  });

  it("without one: syntax markers only, completion and hover off, no schema and no schema request", () => {
    expect(monacoYamlOptions(null)).toEqual({
      validate: true,
      completion: false,
      hover: false,
      hoverSchemaSource: false,
      format: {},
      enableSchemaRequest: false,
      schemas: [],
    });
  });

  it("writes the same settings either way, so monaco-yaml's update (which merges) never keeps one from an earlier pin", () => {
    const withSchema = monacoYamlOptions({ uri: "http://localhost/s.json", schema: {} });
    expect(Object.keys(monacoYamlOptions(null)).sort()).toEqual(Object.keys(withSchema).sort());
  });
});
