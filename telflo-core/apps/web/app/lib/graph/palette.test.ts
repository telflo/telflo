import { TEST_TEMPLATE_RECEIVER_TYPES } from "@telflo/contracts";
import { describe, expect, it } from "vitest";

import { componentPalette, findPaletteEntry, paletteDefaultConfig } from "./palette.js";

describe("the palette", () => {
  it("has 58 entries: 18 receivers, 16 processors, 11 exporters, 9 extensions, 4 connectors", () => {
    expect(componentPalette).toHaveLength(58);
    const count = (type: string) => componentPalette.filter((entry) => entry.type === type).length;
    expect([count("receiver"), count("processor"), count("exporter"), count("extension"), count("connector")]).toEqual([
      18, 16, 11, 9, 4,
    ]);
    expect(new Set(componentPalette.map((entry) => entry.id)).size).toBe(58);
  });

  it("keeps its order, labels, icons and help", () => {
    expect(componentPalette[0]).toMatchObject({
      id: "otlp-receiver",
      type: "receiver",
      subType: "otlp",
      label: "OTLP",
      icon: "Database",
      helpText:
        "Accepts OpenTelemetry data over gRPC (4317) and HTTP (4318) from instrumented apps and other collectors. This is the default ingestion path for OTel.",
    });
    expect(componentPalette.at(-1)?.id).toBe("failover-connector");
    expect(findPaletteEntry("processor", "logdedup")?.label).toBe("Log DeDuplication");
    expect(findPaletteEntry("exporter", "datadog")?.defaultConfig).toMatchObject({
      api: { key: "${env:DD_API_KEY}", site: "datadoghq.com" },
    });
  });

  it("gives only spanmetrics fixed connector signals", () => {
    expect(componentPalette.filter((entry) => entry.connectorSignals).map((entry) => entry.id)).toEqual([
      "spanmetrics-connector",
    ]);
  });

  it("is frozen, and a node takes its own copy of a default config", () => {
    const otlp = findPaletteEntry("receiver", "otlp")!;
    expect(Object.isFrozen(otlp)).toBe(true);
    expect(Object.isFrozen(otlp.defaultConfig)).toBe(true);
    const copy = paletteDefaultConfig(otlp) as { protocols: { grpc: { endpoint: string } } };
    expect(copy).toEqual(otlp.defaultConfig);
    copy.protocols.grpc.endpoint = "0.0.0.0:4317";
    expect((otlp.defaultConfig as typeof copy).protocols.grpc.endpoint).toBe("localhost:4317");
  });

  it("finds an entry by kind and the palette's spelling", () => {
    expect(findPaletteEntry("exporter", "otlp")?.id).toBe("otlp-exporter");
    expect(findPaletteEntry("exporter", "otlp_grpc")).toBeUndefined();
  });
});

describe("the three corrected seeds", () => {
  // contrib CHANGELOG.md:3911-3912 (v0.149.0): `report_extra_scrape_metrics` removed and refused; it is not in
  // receiver/prometheusreceiver/config.go's Config at v0.162.0.
  it("the prometheus receiver's has no report_extra_scrape_metrics", () => {
    expect(findPaletteEntry("receiver", "prometheus")?.defaultConfig).toEqual({
      trim_metric_suffixes: false,
      config: {
        scrape_configs: [{ job_name: "otel-collector", scrape_interval: "10s", static_configs: [{ targets: ["localhost:8888"] }] }],
      },
    });
  });

  // connector/spanmetricsconnector/config.go:25-27 (defaultHistogramBucketsMs) and :139-144 (`Buckets []time.Duration`):
  // the collector's defaults as durations; a bare number would be nanoseconds.
  it("spanmetrics' explicit buckets are the collector's defaults, as durations; the rest unchanged", () => {
    expect(findPaletteEntry("connector", "spanmetrics")?.defaultConfig).toEqual({
      histogram: {
        unit: "ms",
        explicit: {
          buckets: ["2ms", "4ms", "6ms", "8ms", "10ms", "50ms", "100ms", "200ms", "400ms", "800ms", "1s", "1400ms", "2s", "5s", "10s", "15s"],
        },
      },
      dimensions: [],
      aggregation_temporality: "CUMULATIVE",
    });
  });

  // exporter/loadbalancingexporter: unset routing_key is traceID for traces (trace_exporter.go:70, 83) and service for
  // metrics (metrics_exporter.go:70-72) and logs (log_exporter.go:74-75); `traceID` is refused for metrics (:82-83).
  it("load balancing's has no routing_key; its protocol and resolver are unchanged", () => {
    const seed = findPaletteEntry("exporter", "loadbalancing")?.defaultConfig as Record<string, unknown>;
    expect(seed).not.toHaveProperty("routing_key");
    expect(Object.keys(seed)).toEqual(["protocol", "resolver"]);
  });

  // connector/routingconnector/metadata.yaml:14-18: the default is `ignore` since v0.155.0's beta gate; the seed still writes it.
  it("routing's still writes error_mode: ignore", () => {
    expect(findPaletteEntry("connector", "routing")?.defaultConfig).toEqual({ error_mode: "ignore", table: [] });
  });
});

describe("the test templates' receiver types", () => {
  it("are the palette's 18 receivers, in its order, so every type has the palette's label", () => {
    const receivers = componentPalette.filter((entry) => entry.type === "receiver").map((entry) => entry.subType);
    expect([...TEST_TEMPLATE_RECEIVER_TYPES]).toEqual(receivers);
  });
});
