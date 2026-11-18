// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CATALOGUE_VERSIONS,
  offeredVersions,
  PALETTE_DEFAULTS_FIXTURE,
  PALETTE_DEFAULTS_SCRIPT,
  PALETTE_SIGNALS,
  paletteDefaultsFixture,
  paletteDefaultText,
  readCatalogueVersions,
  serializedFixture,
  type CatalogueVersion,
  type PaletteDefaultsFixture,
} from "./palette-defaults.js";
import { spelledType, type RenamedType } from "~/lib/collector/renamed-types.js";
import { readTextModel } from "~/lib/graph/model.js";
import { componentPalette } from "~/lib/graph/palette.js";
import { parse } from "~/lib/graph/parse.js";
import type { PaletteComponent } from "~/lib/graph/types.js";

/*
 * The palette-defaults fixture the validator's binary tests run every
 * offered collector over (D13b decision 9, Preflight ruling 22): the
 * committed file is what scripts/palette-defaults.ts produces from the
 * palette and the catalogue today. This test reads it and never writes it.
 */

const REPOSITORY_ROOT = new URL("../../../../", import.meta.url);

function committedFixture(): string {
  return readFileSync(fileURLToPath(new URL(PALETTE_DEFAULTS_FIXTURE, REPOSITORY_ROOT)), "utf8");
}

const offer = (version: string, deprecated = false, supportedComponents: CatalogueVersion["supportedComponents"] = null) => ({
  version,
  deprecated,
  supportedComponents,
});

function entry(id: string): PaletteComponent {
  const found = componentPalette.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no palette entry ${id}`);
  return found;
}

describe("the palette-defaults fixture", () => {
  it("is what the script writes today", () => {
    const expected = serializedFixture();
    const committed = committedFixture();
    // Not toBe: a stale fixture's message names the script, not a 35 KB diff.
    expect(
      committed === expected,
      `${PALETTE_DEFAULTS_FIXTURE} is stale: the palette or the catalogue changed. Run \`${PALETTE_DEFAULTS_SCRIPT}\` and commit the file.`,
    ).toBe(true);
  });

  it("holds every palette entry once for every offered version", () => {
    const fixture = JSON.parse(committedFixture()) as PaletteDefaultsFixture;
    const offered = offeredVersions(CATALOGUE_VERSIONS["otelcol-contrib"]!).map((entry) => entry.version);
    expect(offered.length).toBeGreaterThan(0);
    for (const paletteEntry of componentPalette) {
      const versions = fixture.cases
        .filter((text) => text.paletteId === paletteEntry.id && text.distribution === "otelcol-contrib")
        .flatMap((text) => text.versions);
      expect(versions.sort(), paletteEntry.id).toEqual([...offered].sort());
    }
  });

  it("spells each component as each of its versions' pin knows it, under the entry's default", () => {
    const fixture = JSON.parse(committedFixture()) as PaletteDefaultsFixture;
    for (const text of fixture.cases) {
      const paletteEntry = entry(text.paletteId);
      for (const version of text.versions) {
        expect(spelledType(paletteEntry.type, paletteEntry.subType, text.distribution, version), text.paletteId).toBe(text.type);
      }
      const parsed = parse(text.yaml);
      expect(parsed.ok, text.paletteId).toBe(true);
      if (!parsed.ok) continue;
      const section = `${paletteEntry.type}s`;
      expect(readTextModel(parsed.document).components.get(`${section}.${text.type}`), text.paletteId).toEqual(
        paletteEntry.defaultConfig,
      );
    }
  });

  it("stores a renamed component's two spellings as two texts, split at the rename", () => {
    const catalogue: Record<string, RenamedType[]> = {
      contrib: [{ kind: "receiver", name: "file_log", deprecatedName: "filelog", since: "0.149.0" }],
    };
    const fixture = paletteDefaultsFixture({ contrib: [offer("0.150.0"), offer("0.148.0"), offer("0.147.0", true)] }, catalogue);
    const filelog = fixture.cases.filter((text) => text.paletteId === "filelog-receiver");

    expect(filelog.map(({ type, versions }) => ({ type, versions }))).toEqual([
      { type: "filelog", versions: ["0.148.0"] },
      { type: "file_log", versions: ["0.150.0"] },
    ]);
    expect(filelog[1]!.yaml).toContain("  file_log:\n");
    expect(filelog[1]!.yaml).toContain("receivers: [file_log]");
    // The texts of the components nobody renamed are stored once for both versions.
    expect(fixture.cases.find((text) => text.paletteId === "otlp-receiver")!.versions).toEqual(["0.148.0", "0.150.0"]);
  });

  it("leaves out the entries a version's toolbox doesn't show", () => {
    const supported = { receivers: ["otlp"], processors: [], exporters: ["debug"], connectors: [], extensions: [] };
    const fixture = paletteDefaultsFixture({ core: [offer("0.162.0", false, supported)] }, { core: [] });

    expect(fixture.cases.map((text) => text.paletteId)).toEqual(["otlp-receiver", "debug-exporter"]);
  });

  it("wires each kind into the smallest configuration around it", () => {
    expect(paletteDefaultText(entry("batch-processor"), "otelcol-contrib", "0.162.0").yaml).toBe(
      [
        "receivers:",
        "  otlp:",
        "    protocols:",
        "      grpc:",
        "        endpoint: localhost:4317",
        "processors:",
        "  batch:",
        "    timeout: 200ms",
        "    send_batch_size: 8192",
        "    send_batch_max_size: 0",
        "    metadata_keys: []",
        "    metadata_cardinality_limit: 1000",
        "exporters:",
        "  debug: {}",
        "service:",
        "  pipelines:",
        "    traces:",
        "      receivers: [otlp]",
        "      processors: [batch]",
        "      exporters: [debug]",
        "",
      ].join("\n"),
    );
    const spanmetrics = paletteDefaultText(entry("spanmetrics-connector"), "otelcol-contrib", "0.162.0").yaml;
    expect(spanmetrics).toContain("    traces:\n      receivers: [otlp]\n      exporters: [span_metrics]\n");
    expect(spanmetrics).toContain("    metrics:\n      receivers: [span_metrics]\n      exporters: [debug]\n");
    const forward = paletteDefaultText(entry("forward-connector"), "otelcol-contrib", "0.162.0").yaml;
    expect(forward).toContain("    traces/out:\n      receivers: [forward]\n      exporters: [debug]\n");
    const extension = paletteDefaultText(entry("zpages-extension"), "otelcol-contrib", "0.162.0").yaml;
    expect(extension).toContain("service:\n  extensions: [zpages]\n");
    const exporter = paletteDefaultText(entry("otlp-exporter"), "otelcol-contrib", "0.162.0").yaml;
    expect(exporter).toContain("    traces:\n      receivers: [otlp]\n      exporters: [otlp_grpc]\n");
  });

  it("stops at a palette entry with no signal, naming it", () => {
    const unknown: PaletteComponent = { ...entry("batch-processor"), id: "nosuch-processor" };

    expect(PALETTE_SIGNALS["nosuch-processor"]).toBeUndefined();
    expect(() => paletteDefaultText(unknown, "otelcol-contrib", "0.162.0")).toThrow(
      "Add the palette entry nosuch-processor to PALETTE_SIGNALS (scripts/palette-defaults.ts).",
    );
  });

  it("has a signal for every palette entry but the connectors", () => {
    const missing = componentPalette
      .filter((candidate) => candidate.type !== "connector" && PALETTE_SIGNALS[candidate.id] === undefined)
      .map((candidate) => candidate.id);
    expect(missing).toEqual([]);
  });
});

describe("the catalogue's versions", () => {
  it("are the offered ones, oldest first, compared as numbers", () => {
    expect(
      offeredVersions([offer("0.10.0"), offer("0.9.0"), offer("0.11.0", true), offer("1.0.0")]).map((entry) => entry.version),
    ).toEqual(["0.9.0", "0.10.0", "1.0.0"]);
  });

  it("are read by distribution, each file checked", () => {
    expect(
      readCatalogueVersions({ "../catalog/distributions/a.json": [{ version: "0.1.0", deprecated: false, supportedComponents: null }] }),
    ).toEqual({ a: [offer("0.1.0")] });
    expect(() => readCatalogueVersions({})).toThrow("catalog/distributions/*.json matched nothing");
    expect(() => readCatalogueVersions({ "x/b.json": [{ version: "0.1.0" }] })).toThrow("b.json has no valid versions list");
    expect(() => readCatalogueVersions({ "x/c.json": "nope" })).toThrow("c.json has no valid versions list");
    expect(() => readCatalogueVersions({ "x/d.json": [null] })).toThrow("d.json has no valid versions list");
  });

  it("include the committed catalogue's", () => {
    expect(Object.keys(CATALOGUE_VERSIONS)).toContain("otelcol-contrib");
  });
});
