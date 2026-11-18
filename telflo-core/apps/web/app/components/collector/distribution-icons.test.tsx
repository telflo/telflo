import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OtelIcon } from "./OtelIcon.js";
import { fullLabelFor, iconFor, iconForDistribution, shortLabelFor } from "./distribution-icons.js";

/*
 * The distribution icons and labels, Contrib only (no ClickStack; D13a
 * decision 1), and the mark's own (Preflight ruling 19).
 */

describe("iconFor", () => {
  it("returns a renderable component for 'otel'", () => {
    const Icon = iconFor("otel");
    expect(Icon).toBe(OtelIcon);
    const { container } = render(<Icon />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("returns the fallback (a renderable component, not undefined) for an unknown key", () => {
    const Icon = iconFor("nope");
    expect(Icon).toBeDefined();
    expect(Icon).not.toBe(OtelIcon);
    const { container } = render(<Icon />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("returns the fallback for null", () => {
    const Icon = iconFor(null);
    expect(Icon).toBe(iconFor("nope"));
    const { container } = render(<Icon />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("returns the fallback for undefined", () => {
    const Icon = iconFor(undefined);
    expect(Icon).toBe(iconFor("nope"));
    const { container } = render(<Icon />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("applies a passed className to the rendered svg", () => {
    const Icon = iconFor("otel");
    const { container } = render(<Icon className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveClass("h-4", "w-4");
  });

  it("applies a passed className to the fallback svg", () => {
    const Icon = iconFor("unknown-key");
    const { container } = render(<Icon className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveClass("h-4", "w-4");
  });
});

describe("shortLabelFor", () => {
  it("returns the compact label for known distributions", () => {
    expect(shortLabelFor("otelcol-contrib", "OpenTelemetry Collector Contrib")).toBe("Otel Contrib");
  });

  it("falls back to the full label for an unregistered distribution", () => {
    expect(shortLabelFor("aws-adot", "AWS Distro for OpenTelemetry")).toBe("AWS Distro for OpenTelemetry");
  });

  it("falls back to the full label for null/undefined ids", () => {
    expect(shortLabelFor(null, "Some Full Label")).toBe("Some Full Label");
    expect(shortLabelFor(undefined, "Some Full Label")).toBe("Some Full Label");
  });
});

describe("iconForDistribution", () => {
  it("maps distribution IDs (not icon keys) to their brand marks", () => {
    // 'otelcol-contrib' is a distribution id, not an icon key: it must find
    // the 'otel' mark rather than the generic glyph.
    expect(iconForDistribution("otelcol-contrib")).toBe(iconFor("otel"));
  });

  it("falls back to the generic glyph for unknown, null, and undefined ids", () => {
    for (const id of ["grafana-alloy", null, undefined]) {
      const Icon = iconForDistribution(id);
      expect(Icon).toBe(iconFor(null));
      const { container } = render(<Icon />);
      expect(container.querySelector("svg")).not.toBeNull();
    }
  });
});

describe("OtelIcon (Preflight ruling 19)", () => {
  it("is the two-tone cncf/artwork mark: its viewBox, two paths, orange then blue, and its name", () => {
    const { container } = render(<OtelIcon />);
    const svg = container.querySelector("svg")!;

    expect(svg).toHaveAttribute("viewBox", "-12.7 -12.7 1024.4 1024.4");
    expect(svg).toHaveAttribute("role", "img");
    expect(svg).toHaveAttribute("aria-label", "OpenTelemetry");
    const fills = [...svg.querySelectorAll("path")].map((path) => path.getAttribute("fill"));
    expect(fills).toEqual(["#F5A800", "#425CC7"]);
    const paths = [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? "");
    expect(paths[0]).toMatch(/^M528\.7 545\.9c-42 42-42 110\.1 0 152\.1/);
    expect(paths[0]).toMatch(/69\.2-69\.2z$/);
    expect(paths[1]).toMatch(/^M565\.9 205\.9L419\.5 352\.3/);
    expect(paths[1]).toMatch(/13\.9-165\.9z$/);
  });
});

describe("fullLabelFor (D12 Preflight ruling 18)", () => {
  it("prefers the catalogue's label", () => {
    expect(fullLabelFor("otelcol-contrib", "Contrib, as the catalogue says")).toBe("Contrib, as the catalogue says");
  });

  it("names Contrib in full without the catalogue", () => {
    expect(fullLabelFor("otelcol-contrib")).toBe("OpenTelemetry Collector Contrib");
  });

  it("prints an unknown distribution's own id, never nothing", () => {
    expect(fullLabelFor("acme-collector")).toBe("acme-collector");
  });
});
