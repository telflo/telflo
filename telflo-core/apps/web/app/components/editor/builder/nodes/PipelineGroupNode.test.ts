import { describe, expect, it } from "vitest";

import { groupBadgeLabel } from "./PipelineGroupNode.js";

describe("the group's badge", () => {
  it("names a plain pipeline by its signal, and a named one by its name", () => {
    expect(groupBadgeLabel("traces", "traces")).toBe("Traces");
    expect(groupBadgeLabel("metrics", "metrics")).toBe("Metrics");
    expect(groupBadgeLabel("logs", "logs")).toBe("Logs");
    expect(groupBadgeLabel("traces/production", "traces")).toBe("traces/production");
  });

  it("falls back to the label for a signal it doesn't know", () => {
    expect(groupBadgeLabel("profiles", undefined)).toBe("profiles");
    expect(groupBadgeLabel("odd", "toString")).toBe("odd");
  });
});
