import { describe, expect, it } from "vitest";

import { filterPaletteByAllowlist, isComponentSupported, type SupportedComponents } from "./distribution-allowlist.js";
import { componentPalette } from "~/lib/graph/palette.js";
import { RENAMED_TYPES } from "./renamed-types.js";
import { COMPONENT_TYPES, type ComponentType } from "~/lib/graph/types.js";

/*
 * The allowlist's cases (D13a decision 6; Preflight ruling 18), their
 * `host_metrics` case D9c's deferred one, and a check that every renamed
 * type the parser knows matches its palette entry.
 */

/** A palette-shaped fixture: only `type` and `subType` drive the filter. */
interface FixtureItem {
  id: string;
  type: ComponentType;
  subType: string;
}

const PALETTE: FixtureItem[] = [
  { id: "otlp-receiver", type: "receiver", subType: "otlp" },
  { id: "kafka-receiver", type: "receiver", subType: "kafka" },
  { id: "filelog-receiver", type: "receiver", subType: "filelog" },
  { id: "hostmetrics-receiver", type: "receiver", subType: "hostmetrics" },
  { id: "otlp-exporter", type: "exporter", subType: "otlp" },
  { id: "otlphttp-exporter", type: "exporter", subType: "otlphttp" },
  { id: "clickhouse-exporter", type: "exporter", subType: "clickhouse" },
  { id: "loki-exporter", type: "exporter", subType: "loki" },
];

/** A smaller distribution's list, in the collector's names. */
const FIXTURE_ALLOWLIST: SupportedComponents = {
  receivers: ["nop", "otlp", "datadog", "file_log", "host_metrics", "prometheus"],
  processors: ["batch", "memory_limiter"],
  exporters: ["debug", "nop", "otlp_grpc", "otlp_http", "clickhouse"],
  connectors: ["forward", "routing"],
  extensions: ["health_check", "pprof"],
};

describe("filterPaletteByAllowlist", () => {
  it("returns the palette unchanged when allowlist is null (contrib)", () => {
    expect(filterPaletteByAllowlist(PALETTE, null)).toBe(PALETTE);
  });

  it("removes a non-listed receiver (kafka) and keeps clickhouse exporter", () => {
    const result = filterPaletteByAllowlist(PALETTE, FIXTURE_ALLOWLIST);
    expect(result.some((c) => c.subType === "kafka")).toBe(false);
    expect(result.some((c) => c.subType === "clickhouse")).toBe(true);
  });

  it("keeps a palette `otlp` exporter when the allowlist has `otlp_grpc` (irregular alias)", () => {
    const result = filterPaletteByAllowlist(PALETTE, FIXTURE_ALLOWLIST);
    expect(result.some((c) => c.type === "exporter" && c.subType === "otlp")).toBe(true);
  });

  it("keeps a palette id that differs only by underscores from the canonical allowed name", () => {
    const result = filterPaletteByAllowlist(PALETTE, FIXTURE_ALLOWLIST);
    // filelog -> file_log, hostmetrics -> host_metrics (D9c's deferred case)
    expect(result.some((c) => c.subType === "filelog")).toBe(true);
    expect(result.some((c) => c.subType === "hostmetrics")).toBe(true);
  });

  it("removes a non-listed exporter (loki)", () => {
    const result = filterPaletteByAllowlist(PALETTE, FIXTURE_ALLOWLIST);
    expect(result.some((c) => c.subType === "loki")).toBe(false);
  });
});

describe("isComponentSupported", () => {
  it("matches an exact canonical name", () => {
    expect(isComponentSupported("exporters", "clickhouse", FIXTURE_ALLOWLIST)).toBe(true);
  });

  it("is case- and underscore-insensitive", () => {
    expect(isComponentSupported("receivers", "FileLog", FIXTURE_ALLOWLIST)).toBe(true);
    expect(isComponentSupported("receivers", "file_log", FIXTURE_ALLOWLIST)).toBe(true);
    expect(isComponentSupported("receivers", "HOST_METRICS", FIXTURE_ALLOWLIST)).toBe(true);
  });

  it("returns false for a component not in the section's allowlist", () => {
    expect(isComponentSupported("receivers", "kafka", FIXTURE_ALLOWLIST)).toBe(false);
    expect(isComponentSupported("exporters", "loki", FIXTURE_ALLOWLIST)).toBe(false);
  });

  it("applies the OTLP-exporter irregular alias: `otlp` is supported when `otlp_grpc` is allowed", () => {
    expect(isComponentSupported("exporters", "otlp", FIXTURE_ALLOWLIST)).toBe(true);
  });

  it("does not apply the OTLP-exporter alias outside the exporters section", () => {
    const withoutOtlpReceiver: SupportedComponents = { ...FIXTURE_ALLOWLIST, receivers: ["file_log"] };
    // The receiver `otlp` is the collector's own name: judged on its own match.
    expect(isComponentSupported("receivers", "otlp", withoutOtlpReceiver)).toBe(false);
  });

  it("does not apply the OTLP alias when `otlp_grpc` isn't in the exporters allowlist", () => {
    const withoutOtlpGrpc: SupportedComponents = { ...FIXTURE_ALLOWLIST, exporters: ["debug", "clickhouse"] };
    expect(isComponentSupported("exporters", "otlp", withoutOtlpGrpc)).toBe(false);
  });
});

describe("the collector's renamed types", () => {
  const SECTION: Record<ComponentType, keyof SupportedComponents> = {
    receiver: "receivers",
    processor: "processors",
    exporter: "exporters",
    connector: "connectors",
    extension: "extensions",
  };

  // Every rename is kind-specific (D13b Preflight ruling 15): the OTLP
  // receiver keeps `otlp`, only the exporter became `otlp_grpc`.
  it.each(COMPONENT_TYPES.flatMap((kind) => Object.entries(RENAMED_TYPES[kind]).map(([name, old]) => [kind, name, old] as const)))(
    "a distribution listing the %s `%s` keeps the palette's `%s`",
    (kind, collectorName, paletteName) => {
      // The palette entry the parser maps the collector's name to.
      const entries = componentPalette.filter((entry) => entry.type === kind && entry.subType === paletteName);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        const allowlist: SupportedComponents = {
          receivers: [],
          processors: [],
          exporters: [],
          connectors: [],
          extensions: [],
          [SECTION[entry.type]]: [collectorName],
        };
        expect(isComponentSupported(SECTION[entry.type], entry.subType, allowlist)).toBe(true);
      }
    },
  );
});
