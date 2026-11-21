import { PIPELINE_GROUP_HEIGHT, PIPELINE_GROUP_WIDTH } from "./constants.js";
import type { OTelNode, Pipeline } from "./types.js";

/*
 * The graph's node and pipeline builders, and their ids: every
 * id is a prefix and a number, the lowest the graph doesn't use, and nothing
 * is ever derived from a name (a group's id never holds its pipeline's).
 */

const GROUP_X = 100;
export const GROUP_Y_OFFSET = 50;
export const GROUP_Y_STRIDE = 300;
const GROUP_Y_SPACING = 50;
export const DEFAULT_GROUP_COLOR = "#64748b";

// Color palette for custom pipelines
export const CUSTOM_PIPELINE_COLORS = [
  "#f97316", // orange-500
  "#3b82f6", // blue-500
  "#64748b", // slate-600
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
  "#14b8a6", // teal-500
  "#f59e0b", // amber-500
  "#10b981", // emerald-500
  "#6366f1", // indigo-500
  "#ef4444", // red-500
  "#06b6d4", // cyan-500
  "#84cc16", // lime-500
] as const;

/** The color a pipeline of each signal starts with (the parser's and the defaults'). */
export const SIGNAL_TYPE_COLORS = {
  traces: "#f97316", // orange-500
  metrics: "#3b82f6", // blue-500
  logs: "#64748b", // slate-600
} as const;

// Generate a color for a new pipeline: first unused palette color, or if all
// are taken, rotate through the palette by modulo of how many colors are in use.
export function generatePipelineColor(existingColors: readonly string[]): string {
  const unusedColor = CUSTOM_PIPELINE_COLORS.find((c) => !existingColors.includes(c));

  return unusedColor ?? CUSTOM_PIPELINE_COLORS[existingColors.length % CUSTOM_PIPELINE_COLORS.length] ?? DEFAULT_GROUP_COLOR;
}

/** `<prefix>_<n>` for the lowest `n` that `existingIds` doesn't hold. */
function lowestFreeId(prefix: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  let n = 0;
  while (taken.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

/** A component node's id: `node_<n>`. */
export function nextNodeId(existingIds: Iterable<string>): string {
  return lowestFreeId("node", existingIds);
}

/** An edge's id: `edge_<n>`. */
export function nextEdgeId(existingIds: Iterable<string>): string {
  return lowestFreeId("edge", existingIds);
}

/** A pipeline's id: `pipeline_<n>`. */
export function nextPipelineId(existingIds: Iterable<string>): string {
  return lowestFreeId("pipeline", existingIds);
}

/**
 * A pipeline's group node's id: `group_<n>`, with its pipeline's `n`
 * (`pipeline_3`'s group is `group_3`), which no other group holds because
 * pipeline ids are unique.
 */
export function groupIdForPipeline(pipelineId: string): string {
  return `group_${pipelineId.replace(/^pipeline_/, "")}`;
}

export function groupYPosition(index: number): number {
  return GROUP_Y_OFFSET + index * GROUP_Y_STRIDE;
}

function styleHeight(node: OTelNode): number | undefined {
  const height = node.style?.height;
  return typeof height === "number" ? height : undefined;
}

// Y for a new group placed below all existing ones.
export function nextGroupYPosition(existingGroupNodes: readonly OTelNode[]): number {
  const maxBottom = existingGroupNodes.reduce(
    (max, n) => Math.max(max, n.position.y + (styleHeight(n) ?? PIPELINE_GROUP_HEIGHT)),
    GROUP_Y_OFFSET,
  );
  return maxBottom + GROUP_Y_SPACING;
}

/** The three default pipelines (traces, metrics, logs), with the builders' ids. */
export const getDefaultPipelines = (): Pipeline[] => [
  {
    id: "pipeline_0",
    name: "traces",
    signalType: "traces",
    color: SIGNAL_TYPE_COLORS.traces,
  },
  {
    id: "pipeline_1",
    name: "metrics",
    signalType: "metrics",
    color: SIGNAL_TYPE_COLORS.metrics,
  },
  {
    id: "pipeline_2",
    name: "logs",
    signalType: "logs",
    color: SIGNAL_TYPE_COLORS.logs,
  },
];

export function createGroupNode(pipeline: Pipeline, yPosition: number): OTelNode {
  return {
    id: groupIdForPipeline(pipeline.id),
    type: "pipelineGroup",
    position: { x: GROUP_X, y: yPosition },
    data: {
      label: pipeline.name,
      pipelineId: pipeline.id,
      signalType: pipeline.signalType,
      color: pipeline.color ?? DEFAULT_GROUP_COLOR,
      componentType: "pipelineGroup",
      componentSubType: "pipelineGroup",
      config: {},
    },
    style: { width: PIPELINE_GROUP_WIDTH, height: PIPELINE_GROUP_HEIGHT },
  };
}

export function createDefaultGroupNodes(): OTelNode[] {
  return getDefaultPipelines().map((pipeline, index) => createGroupNode(pipeline, groupYPosition(index)));
}
