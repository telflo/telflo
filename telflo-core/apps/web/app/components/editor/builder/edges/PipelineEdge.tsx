import { BaseEdge, getBezierPath, Position, type EdgeProps } from "@xyflow/react";

import type { OTelEdge } from "~/lib/graph/types.js";

/**
 * The arrowhead pointing into the target handle: 8 px long, 4 px half-width,
 * its tip 4 px shy of the handle's center, turned for the side the edge
 * enters from.
 */
export function arrowPath(x: number, y: number, position: Position): string {
  const length = 8;
  const halfWidth = 4;
  const gap = 4;
  switch (position) {
    case Position.Right:
      return `M ${x + gap + length} ${y - halfWidth} L ${x + gap} ${y} L ${x + gap + length} ${y + halfWidth} Z`;
    case Position.Top:
      return `M ${x - halfWidth} ${y - gap - length} L ${x} ${y - gap} L ${x + halfWidth} ${y - gap - length} Z`;
    case Position.Bottom:
      return `M ${x - halfWidth} ${y + gap + length} L ${x} ${y + gap} L ${x + halfWidth} ${y + gap + length} Z`;
    case Position.Left:
    default:
      return `M ${x - gap - length} ${y - halfWidth} L ${x - gap} ${y} L ${x - gap - length} ${y + halfWidth} Z`;
  }
}

/**
 * A pipeline edge: a bezier with an arrowhead and marching dashes
 * (`tf-edge-flow`, off under reduced motion), gray at rest, the brand color
 * with a halo when selected. The path's `id` is the edge's opaque id.
 */
export function PipelineEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  selected,
}: EdgeProps<OTelEdge>) {
  const edgeColor = selected ? "var(--color-brand, #2364d2)" : "var(--color-gray-400, #98a1ac)";
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        {...(markerEnd !== undefined ? { markerEnd } : {})}
        className="tf-edge-flow"
        style={{ ...style, stroke: edgeColor, strokeWidth: selected ? 2 : 1.5 }}
      />
      <path d={arrowPath(targetX, targetY, targetPosition)} fill={edgeColor} pointerEvents="none" />
      {selected && (
        <BaseEdge
          id={`${id}-halo`}
          path={edgePath}
          style={{ stroke: edgeColor, strokeWidth: 7, opacity: 0.15, pointerEvents: "none" }}
        />
      )}
    </>
  );
}
