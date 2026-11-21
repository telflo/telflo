import { ArrowRightLeft, Box, Database, HeartPulse, Package, Send, Split } from "lucide-react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { componentIcon, LUCIDE_ICONS, VENDOR_MARKS } from "./component-icons.js";
import { ClickStackIcon } from "./icons/ClickStackIcon.js";
import { DatadogIcon } from "./icons/DatadogIcon.js";
import { KubernetesIcon } from "./icons/KubernetesIcon.js";
import { componentPalette } from "~/lib/graph/palette.js";

describe("the one icon map", () => {
  it("gives every palette entry its vendor mark or its own lucide icon, never a fallback", () => {
    for (const entry of componentPalette) {
      const icon = componentIcon(entry.type, entry.subType);
      const expected = VENDOR_MARKS[entry.subType] ?? LUCIDE_ICONS[entry.icon];
      expect(expected, `${entry.id} (${entry.icon})`).toBeDefined();
      expect(icon, entry.id).toBe(expected);
    }
  });

  it("uses the vendor marks for Kubernetes, Datadog and ClickHouse, in every kind", () => {
    for (const subType of ["k8s_cluster", "k8s_events", "k8sobjects", "kubeletstats"]) {
      expect(componentIcon("receiver", subType)).toBe(KubernetesIcon);
    }
    expect(componentIcon("processor", "k8sattributes")).toBe(KubernetesIcon);
    expect(componentIcon("receiver", "datadog")).toBe(DatadogIcon);
    expect(componentIcon("exporter", "datadog")).toBe(DatadogIcon);
    expect(componentIcon("exporter", "clickhouse")).toBe(ClickStackIcon);
  });

  it("gives the palette's icons on the canvas too (one map)", () => {
    // The palette's icons, which the canvas shows as well.
    expect(componentIcon("connector", "routing")).toBe(Split);
    expect(componentIcon("receiver", "otlp")).toBe(Database);
  });

  it("falls back to the type's icon outside the palette, and a box for anything else", () => {
    expect(componentIcon("receiver", "nosuch")).toBe(Database);
    expect(componentIcon("processor", "nosuch")).toBe(Package);
    expect(componentIcon("exporter", "nosuch")).toBe(Send);
    expect(componentIcon("extension", "nosuch")).toBe(HeartPulse);
    expect(componentIcon("connector", "count")).toBe(ArrowRightLeft);
    expect(componentIcon("pipelineGroup", "")).toBe(Box);
    expect(componentIcon("receiver", "toString")).toBe(Database);
    expect(componentIcon("constructor", "otlp")).toBe(Box);
  });
});

describe("the vendor marks", () => {
  it.each([
    ["Kubernetes", KubernetesIcon, "0 0 128 128"],
    ["Datadog", DatadogIcon, "0 0 24 24"],
    ["ClickStack", ClickStackIcon, "0 0 30.38 27"],
  ])("draw %s as a decorative silhouette in the text's color", (_name, Icon, viewBox) => {
    const { container } = render(<Icon className="h-3.5 w-3.5" strokeWidth={1.75} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("viewBox", viewBox);
    expect(svg).toHaveAttribute("fill", "currentColor");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-3.5", "w-3.5");
    expect(svg.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(svg.querySelector("title")).toBeNull();
  });
});
