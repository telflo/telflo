// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CATALOGUE_RENAMED_TYPES,
  isAtOrAfter,
  RENAMED_TYPES,
  readRenamedTypes,
  renamedTypeTable,
  spelledType,
  type RenamedType,
} from "./renamed-types.js";
import { findPaletteEntry } from "~/lib/graph/palette.js";
import { paletteSubType } from "~/lib/graph/parse.js";
import { COMPONENT_TYPES } from "~/lib/graph/types.js";

/*
 * The web's renames come from the catalogue (D13b decision 6, Preflight
 * ruling 15): what Vite bundled is what the files say, read here again
 * from the disk, and every rename is kind-specific.
 */

/** The repository's catalogue folder, read from the disk, not through Vite. */
const CATALOGUE_DIRECTORY = fileURLToPath(new URL("../../../../../../catalog/distributions/", import.meta.url));

/** Each catalogue file's `renamedTypes`, by distribution, from the disk. */
function renamedTypesOnDisk(): Record<string, unknown> {
  return Object.fromEntries(
    readdirSync(CATALOGUE_DIRECTORY)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [
        name.replace(/\.json$/, ""),
        (JSON.parse(readFileSync(`${CATALOGUE_DIRECTORY}${name}`, "utf8")) as { renamedTypes: unknown }).renamedTypes,
      ]),
  );
}

const FILE_LOG = { kind: "receiver", name: "file_log", deprecatedName: "filelog", since: "0.149.0" } as const;

describe("the renames the web is built with", () => {
  it("are exactly the catalogue's files' renamedTypes, by distribution, in each file's order", () => {
    const onDisk = renamedTypesOnDisk();
    expect(Object.keys(onDisk).length).toBeGreaterThan(0);
    expect(CATALOGUE_RENAMED_TYPES).toEqual(onDisk);
  });

  it("table every kind's renames as the union of the files: each entry's name maps to its deprecated name in its kind, and nothing else", () => {
    const expected = Object.fromEntries(COMPONENT_TYPES.map((kind) => [kind, {} as Record<string, string>]));
    for (const renames of Object.values(renamedTypesOnDisk()) as Array<Array<typeof FILE_LOG>>) {
      for (const { kind, name, deprecatedName } of renames) expected[kind]![name] = deprecatedName;
    }
    expect(RENAMED_TYPES).toEqual(expected);
    expect(Object.values(RENAMED_TYPES).flatMap((renames) => Object.keys(renames)).length).toBeGreaterThan(0);
    expect(RENAMED_TYPES.receiver.file_log).toBe("filelog");
    expect(RENAMED_TYPES.exporter.otlp_grpc).toBe("otlp");
  });

  it("give every rename's deprecated name a palette entry of its kind", () => {
    for (const kind of COMPONENT_TYPES) {
      for (const [name, deprecatedName] of Object.entries(RENAMED_TYPES[kind])) {
        expect(findPaletteEntry(kind, paletteSubType(name, kind))?.subType, `${kind} ${name}`).toBe(deprecatedName);
      }
    }
  });
});

describe("paletteSubType: renames are kind-specific (Preflight ruling 15, D9d's final ruling F8 generalised)", () => {
  it("maps a current name to its palette spelling in its own kind, and keeps it in every other", () => {
    for (const kind of COMPONENT_TYPES) {
      for (const [name, deprecatedName] of Object.entries(RENAMED_TYPES[kind])) {
        expect(paletteSubType(name, kind)).toBe(deprecatedName);
        for (const other of COMPONENT_TYPES.filter((type) => type !== kind)) {
          if (!Object.hasOwn(RENAMED_TYPES[other], name)) expect(paletteSubType(name, other)).toBe(name);
        }
      }
    }
    // The cases D13b changed: before, every rename but aws_s3's applied to every kind.
    expect(paletteSubType("otlp_grpc", "exporter")).toBe("otlp");
    expect(paletteSubType("otlp_grpc", "receiver")).toBe("otlp_grpc");
    expect(paletteSubType("file_log", "exporter")).toBe("file_log");
    expect(paletteSubType("aws_s3", "receiver")).toBe("awss3");
    expect(paletteSubType("aws_s3", "exporter")).toBe("aws_s3");
  });

  it("keeps a type that isn't renamed, the deprecated spelling, and an inherited property's name", () => {
    expect(paletteSubType("filelog", "receiver")).toBe("filelog");
    expect(paletteSubType("batch", "processor")).toBe("batch");
    expect(paletteSubType("constructor", "processor")).toBe("constructor");
    expect(paletteSubType("__proto__", "extension")).toBe("__proto__");
  });
});

describe("reading the catalogue's renames", () => {
  it("names each distribution by its file, in the files' order", () => {
    expect(
      readRenamedTypes({
        "../../catalog/distributions/zeta.json": [],
        "../../catalog/distributions/otelcol-contrib.json": [FILE_LOG],
      }),
    ).toEqual({ "otelcol-contrib": [FILE_LOG], zeta: [] });
  });

  it("refuses no file at all: the glob matched nothing (catalog/ missing where the web is built; Ruling 53)", () => {
    expect(() => readRenamedTypes({})).toThrow(
      "The collector catalogue's distribution files weren't found: catalog/distributions/*.json matched nothing.",
    );
  });

  it.each([
    ["no renamedTypes", undefined],
    ["a renamedTypes that isn't a list", {}],
    ["an unknown kind", [{ ...FILE_LOG, kind: "pipeline" }]],
    ["a plural kind", [{ ...FILE_LOG, kind: "receivers" }]],
    ["a malformed name", [{ ...FILE_LOG, name: "File-Log" }]],
    ["a malformed since", [{ ...FILE_LOG, since: "v0.149.0" }]],
    ["an unknown field", [{ ...FILE_LOG, note: "x" }]],
  ])("refuses a file with %s, naming it", (_label, renamedTypes) => {
    expect(() => readRenamedTypes({ "../../catalog/distributions/acme.json": renamedTypes })).toThrow(
      "The collector catalogue's acme.json has no valid renamedTypes list.",
    );
  });

  it("tables the union of the files by kind, a name renamed in two kinds kept apart", () => {
    const table = renamedTypeTable({
      "otelcol-contrib": [FILE_LOG],
      acme: [FILE_LOG, { kind: "exporter", name: "file_log", deprecatedName: "file", since: "1.0.0" }],
    });
    expect(table).toEqual({
      receiver: { file_log: "filelog" },
      processor: {},
      exporter: { file_log: "file" },
      extension: {},
      connector: {},
    });
  });

  it("refuses two files that give a kind's name different deprecated names", () => {
    expect(() =>
      renamedTypeTable({ "otelcol-contrib": [FILE_LOG], acme: [{ ...FILE_LOG, deprecatedName: "logfile" }] }),
    ).toThrow("The collector catalogue's acme.json renames the receiver file_log from logfile; another file says filelog.");
  });
});

/** Each catalogue file's offered (not deprecated) versions, by distribution, from the disk. */
function offeredVersionsOnDisk(): Record<string, string[]> {
  return Object.fromEntries(
    readdirSync(CATALOGUE_DIRECTORY)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const file = JSON.parse(readFileSync(`${CATALOGUE_DIRECTORY}${name}`, "utf8")) as {
          versions: Array<{ version: string; deprecated: boolean }>;
        };
        return [name.replace(/\.json$/, ""), file.versions.filter((entry) => !entry.deprecated).map((entry) => entry.version)];
      }),
  );
}

describe("isAtOrAfter: collector versions compared as numbers", () => {
  it.each([
    ["0.149.0", "0.149.0", true],
    ["0.149.1", "0.149.0", true],
    ["0.150.0", "0.149.0", true],
    ["1.0.0", "0.149.0", true],
    ["0.148.9", "0.149.0", false],
    ["0.99.0", "0.149.0", false],
    ["0.149.0", "0.149.1", false],
    ["0.1000.0", "0.999.0", true],
    ["0.149.0", "1.0.0", false],
    ["99999999999999999999.0.0", "99999999999999999998.0.0", true],
  ])("%s at or after %s: %s", (version, since, expected) => {
    expect(isAtOrAfter(version, since)).toBe(expected);
  });

  it("is false for a version that isn't major.minor.patch", () => {
    expect(isAtOrAfter("v0.162.0", "0.149.0")).toBe(false);
    expect(isAtOrAfter("0.162", "0.149.0")).toBe(false);
    expect(isAtOrAfter("latest", "0.149.0")).toBe(false);
    expect(isAtOrAfter("0.162.0", "")).toBe(false);
  });
});

describe("spelledType: what the palette writes for the pin (D13b decision 5)", () => {
  /** A distribution with its own since values, unlike Contrib's, and a rename Contrib doesn't have. */
  const ACME_RENAMES: readonly RenamedType[] = [
    { kind: "receiver", name: "file_log", deprecatedName: "filelog", since: "1.4.0" },
    { kind: "exporter", name: "otlp_grpc", deprecatedName: "otlp", since: "2.0.0" },
    { kind: "processor", name: "batcher", deprecatedName: "batch", since: "1.10.0" },
  ];
  const CATALOGUE = { acme: ACME_RENAMES, "otelcol-contrib": CATALOGUE_RENAMED_TYPES["otelcol-contrib"]! };

  it.each([
    ["receiver", "filelog", "1.3.9", "filelog"],
    ["receiver", "filelog", "1.4.0", "file_log"],
    ["receiver", "filelog", "1.4.1", "file_log"],
    ["exporter", "otlp", "1.99.99", "otlp"],
    ["exporter", "otlp", "2.0.0", "otlp_grpc"],
    ["exporter", "otlp", "2.1.0", "otlp_grpc"],
    // Numbers, not text: 1.9.0 is before 1.10.0.
    ["processor", "batch", "1.9.0", "batch"],
    ["processor", "batch", "1.10.0", "batcher"],
    ["processor", "batch", "1.11.0", "batcher"],
  ] as const)("acme's %s %s on %s is written %s", (kind, paletteType, pin, expected) => {
    expect(spelledType(kind, paletteType, "acme", pin, CATALOGUE)).toBe(expected);
  });

  it("reads the configuration's distribution's renames only", () => {
    // Contrib renamed filelog in 0.149.0; acme only in 1.4.0.
    expect(spelledType("receiver", "filelog", "otelcol-contrib", "1.0.0", CATALOGUE)).toBe("file_log");
    expect(spelledType("receiver", "filelog", "acme", "1.0.0", CATALOGUE)).toBe("filelog");
    // Contrib has no batcher.
    expect(spelledType("processor", "batch", "otelcol-contrib", "9.0.0", CATALOGUE)).toBe("batch");
  });

  it("is kind-specific: another kind of the same palette type keeps its name", () => {
    expect(spelledType("receiver", "otlp", "acme", "3.0.0", CATALOGUE)).toBe("otlp");
    expect(spelledType("exporter", "filelog", "acme", "3.0.0", CATALOGUE)).toBe("filelog");
  });

  it("matches the palette's name, not the current one: a current name is written as it is", () => {
    expect(spelledType("receiver", "file_log", "acme", "0.1.0", CATALOGUE)).toBe("file_log");
  });

  it("keeps the old name with no pin, no distribution, a distribution the catalogue doesn't list, or a pin not in the format", () => {
    expect(spelledType("receiver", "filelog", "acme", null, CATALOGUE)).toBe("filelog");
    expect(spelledType("receiver", "filelog", null, "9.0.0", CATALOGUE)).toBe("filelog");
    expect(spelledType("receiver", "filelog", "zeta", "9.0.0", CATALOGUE)).toBe("filelog");
    expect(spelledType("receiver", "filelog", "constructor", "9.0.0", CATALOGUE)).toBe("filelog");
    expect(spelledType("receiver", "filelog", "acme", "v9.0.0", CATALOGUE)).toBe("filelog");
  });

  it("reads the catalogue the web is built with by default", () => {
    expect(spelledType("receiver", "filelog", "otelcol-contrib", "0.149.0")).toBe("file_log");
    expect(spelledType("receiver", "filelog", "otelcol-contrib", "0.148.0")).toBe("filelog");
  });

  it("writes every Contrib rename's current name from its since on, the old name before, on each offered version", () => {
    const offered = offeredVersionsOnDisk()["otelcol-contrib"]!;
    expect(offered.length).toBeGreaterThan(0);
    for (const { kind, name, deprecatedName, since } of CATALOGUE_RENAMED_TYPES["otelcol-contrib"]!) {
      for (const version of offered) {
        const written = spelledType(kind, deprecatedName, "otelcol-contrib", version);
        expect(written, `${kind} ${deprecatedName} on ${version}`).toBe(isAtOrAfter(version, since) ? name : deprecatedName);
      }
    }
    // Contrib when D13b was built: aws_s3 (0.162.0) was the only rename an offered version predated.
    expect(spelledType("receiver", "awss3", "otelcol-contrib", "0.161.0")).toBe("awss3");
    expect(spelledType("receiver", "awss3", "otelcol-contrib", "0.162.0")).toBe("aws_s3");
  });
});
