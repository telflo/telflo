import { describe, expect, it } from "vitest";
import { resolveFlowVersion } from "./resolve-flow-version.js";

/*
 * The version select's cases. The fallback is the catalog's default
 * version, so the cases that took the list's first give the default, which
 * here is not the first; one more case shows the first standing in when
 * none is flagged.
 */

/** Versions as the catalog offers them, newest first; `defaultVersion` flagged. */
function offers(versions: string[], defaultVersion?: string) {
  return versions.map((version) => ({ version, isDefault: version === defaultVersion }));
}

describe("resolveFlowVersion", () => {
  it("keeps the flow's pinned version when editing and the distribution is unchanged", () => {
    expect(
      resolveFlowVersion("", "otelcol-contrib", "0.140.0", "otelcol-contrib", offers(["0.147.0", "0.140.0"], "0.147.0")),
    ).toBe("0.140.0");
  });

  it("does NOT fall back to the flow's old version when the distribution changed", () => {
    // A version belongs to its distribution: 0.140.0 (a Contrib version) is
    // not necessarily one the other distribution has, so its default wins.
    expect(
      resolveFlowVersion("", "otelcol-contrib", "0.140.0", "acme-collector", offers(["2.1.0", "2.0.0"], "2.0.0")),
    ).toBe("2.0.0");
  });

  it("uses the catalog's default version for a brand-new flow (no pin to consult)", () => {
    expect(
      resolveFlowVersion("", null, null, "otelcol-contrib", offers(["0.163.0", "0.162.0", "0.161.0"], "0.162.0")),
    ).toBe("0.162.0");
  });

  it("returns an empty string when no versions are available yet", () => {
    expect(resolveFlowVersion("", null, null, "otelcol-contrib", [])).toBe("");
  });

  it("keeps a pick already in flight rather than overriding it", () => {
    expect(
      resolveFlowVersion("0.130.0", "otelcol-contrib", "0.140.0", "otelcol-contrib", offers(["0.147.0", "0.140.0"], "0.147.0")),
    ).toBe("0.130.0");
  });

  it("falls back to the distribution's default version when the flow has no pin for it", () => {
    // The distribution is the flow's own, but its pin is blank: the same "no
    // pin to trust" case as a new flow.
    expect(
      resolveFlowVersion("", "otelcol-contrib", "", "otelcol-contrib", offers(["0.163.0", "0.162.0"], "0.162.0")),
    ).toBe("0.162.0");
  });

  it("takes the newest version when the catalog flags no default", () => {
    expect(resolveFlowVersion("", null, null, "otelcol-contrib", offers(["0.147.0", "0.140.0"]))).toBe("0.147.0");
  });

  it("keeps a pin the catalog no longer offers while the distribution is the flow's", () => {
    expect(
      resolveFlowVersion("", "otelcol-contrib", "0.155.0", "otelcol-contrib", offers(["0.162.0", "0.161.0"], "0.162.0")),
    ).toBe("0.155.0");
  });
});
