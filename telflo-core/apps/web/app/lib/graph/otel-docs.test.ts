import { describe, expect, it } from "vitest";

import { getComponentDocsUrl } from "./otel-docs.js";
import { componentPalette } from "./palette.js";

describe("getComponentDocsUrl", () => {
  it("links a core component to the core repository and a contrib one to contrib", () => {
    expect(getComponentDocsUrl("receiver", "otlp")).toBe(
      "https://github.com/open-telemetry/opentelemetry-collector/tree/main/receiver/otlpreceiver",
    );
    expect(getComponentDocsUrl("exporter", "datadog")).toBe(
      "https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/datadogexporter",
    );
  });

  it("tells a receiver from an exporter of the same type", () => {
    expect(getComponentDocsUrl("exporter", "otlp")).toContain("/exporter/otlpexporter");
  });

  it("has a link for every palette entry, and none for an unknown component", () => {
    for (const entry of componentPalette) {
      expect(getComponentDocsUrl(entry.type, entry.subType), entry.id).not.toBeNull();
    }
    expect(getComponentDocsUrl("receiver", "mysterious")).toBeNull();
  });
});
