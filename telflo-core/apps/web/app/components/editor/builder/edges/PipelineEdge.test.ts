import { Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import { arrowPath } from "./PipelineEdge.js";

describe("the arrowhead", () => {
  it("points into the handle from each side, its tip 4 px shy of it", () => {
    expect(arrowPath(100, 50, Position.Left)).toBe("M 88 46 L 96 50 L 88 54 Z");
    expect(arrowPath(100, 50, Position.Right)).toBe("M 112 46 L 104 50 L 112 54 Z");
    expect(arrowPath(100, 50, Position.Top)).toBe("M 96 38 L 100 46 L 104 38 Z");
    expect(arrowPath(100, 50, Position.Bottom)).toBe("M 96 62 L 100 54 L 104 62 Z");
  });
});
