import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";

import type { OTelEdge } from "~/lib/graph/types.js";

/**
 * A route edge: the derived, read-only edge from a routing or
 * failover connector to a pipeline it targets, dashed in the connector
 * colour, with a chip saying why ("2 routes + default", "priority 1").
 * Never stored: the canvas builds these from the connector's config on
 * every render (`buildRouteEdges`). The chip is text, with fixed words and
 * numbers only.
 */
export function RouteEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<OTelEdge>) {
  const edgeColor = "var(--color-node-connector, #8b5cf6)";
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const label = data?.label;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: edgeColor, strokeWidth: 1.5, strokeDasharray: "6 4", opacity: 0.7 }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="rounded-[4px] border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] leading-4 text-muted-foreground shadow-sm"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
