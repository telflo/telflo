import { describe, it, expect } from "vitest";
import {
  createDefaultGroupNodes,
  createGroupNode,
  generatePipelineColor,
  getDefaultPipelines,
  groupIdForPipeline,
  nextEdgeId,
  nextGroupYPosition,
  nextNodeId,
  nextPipelineId,
} from "./node-builders.js";

describe("generatePipelineColor", () => {
  it("picks the first palette color not already used by existing pipelines", () => {
    // Palette starts with #f97316, #3b82f6, #64748b, #8b5cf6, ...
    const used = ["#f97316", "#3b82f6"];
    const color = generatePipelineColor(used);
    expect(color).toBe("#64748b");
  });

  it("returns the first palette color when no colors are used yet", () => {
    const color = generatePipelineColor([]);
    expect(color).toBe("#f97316");
  });

  it("rotates through the palette by modulo once every color is used", () => {
    const fullPalette = [
      "#f97316",
      "#3b82f6",
      "#64748b",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#f59e0b",
      "#10b981",
      "#6366f1",
      "#ef4444",
      "#06b6d4",
      "#84cc16",
    ];
    // All 12 palette colors used; existingColors.length (12) % 12 === 0
    const color = generatePipelineColor(fullPalette);
    expect(color).toBe(fullPalette[0]);
  });

  it("rotates to the next index when used colors exceed the palette length", () => {
    // 13 used colors (with a duplicate) -> 13 % 12 === 1
    const usedWithDuplicate = [
      "#f97316",
      "#3b82f6",
      "#64748b",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#f59e0b",
      "#10b981",
      "#6366f1",
      "#ef4444",
      "#06b6d4",
      "#84cc16",
      "#f97316", // duplicate, still "used" so all colors remain taken
    ];
    const color = generatePipelineColor(usedWithDuplicate);
    expect(color).toBe("#3b82f6");
  });
});

describe("ids (decision 7)", () => {
  it("gives the lowest number no id holds, for nodes, edges and pipelines", () => {
    expect(nextNodeId([])).toBe("node_0");
    expect(nextNodeId(["node_0", "node_2"])).toBe("node_1");
    expect(nextEdgeId(["edge_0", "edge_1", "node_2"])).toBe("edge_2");
    expect(nextPipelineId(new Set(["pipeline_1"]))).toBe("pipeline_0");
  });

  it("gives a pipeline's group its pipeline's number", () => {
    expect(groupIdForPipeline("pipeline_7")).toBe("group_7");
    expect(createGroupNode({ id: "pipeline_3", name: "traces/production", signalType: "traces" }, 50).id).toBe(
      "group_3",
    );
  });

  it("never derives an id from a pipeline's name", () => {
    const group = createGroupNode({ id: "pipeline_0", name: "traces/tenant-acme", signalType: "traces" }, 50);
    expect(group.id).not.toContain("acme");
    expect(group.data.label).toBe("traces/tenant-acme");
    expect(group.data.pipelineId).toBe("pipeline_0");
  });
});

describe("default pipelines and groups", () => {
  it("are traces, metrics and logs, with opaque ids and their signal colours", () => {
    expect(getDefaultPipelines()).toEqual([
      { id: "pipeline_0", name: "traces", signalType: "traces", color: "#f97316" },
      { id: "pipeline_1", name: "metrics", signalType: "metrics", color: "#3b82f6" },
      { id: "pipeline_2", name: "logs", signalType: "logs", color: "#64748b" },
    ]);
    const groups = createDefaultGroupNodes();
    expect(groups.map((g) => [g.id, g.position.y, g.data.label])).toEqual([
      ["group_0", 50, "traces"],
      ["group_1", 350, "metrics"],
      ["group_2", 650, "logs"],
    ]);
    expect(groups[0]?.style).toEqual({ width: 900, height: 200 });
  });

  it("places a new group below the lowest one", () => {
    const groups = createDefaultGroupNodes();
    expect(nextGroupYPosition(groups)).toBe(650 + 200 + 50);
    expect(nextGroupYPosition([])).toBe(100);
  });
});
