import type { NodeProps } from "@xyflow/react";
import { Handle, NodeResizer, Position } from "@xyflow/react";

import type { OTelNode } from "~/lib/graph/types.js";
import { selectIsVersionPublished, useEditorStore } from "~/lib/stores/editor-store.js";

const SIGNAL_LABELS: Readonly<Record<string, string>> = {
  traces: "Traces",
  metrics: "Metrics",
  logs: "Logs",
};

/** A group's minimum size while resized. */
export const GROUP_MIN_WIDTH = 300;
export const GROUP_MIN_HEIGHT = 150;

/** The group's anchors for edges drawn to and from the group itself (read-only; never connectable). */
export const GROUP_TARGET_HANDLE = "route";
export const GROUP_SOURCE_HANDLE = "anchor";

/**
 * The badge's text: "Traces" for the pipeline `traces` (uppercased by CSS),
 * or the pipeline's name when it has an instance (`traces/production`).
 */
export function groupBadgeLabel(label: string, signalType: string | undefined): string {
  if (label.includes("/")) return label;
  return (signalType !== undefined && Object.hasOwn(SIGNAL_LABELS, signalType) ? SIGNAL_LABELS[signalType] : undefined) ?? label;
}

/**
 * A pipeline group's node: a dashed box with a 5 % fill in the
 * pipeline's colour, its badge, and a resizer while selected (300 × 150 at
 * least). Two invisible, unconnectable handles anchor the edges drawn to and
 * from the group: the route edges of routing and failover connectors, and a
 * connector's edge in a pipeline with nothing else to join (Task 3's
 * ruling). The pipeline's name is text in the badge, never an attribute.
 * A published version's groups show no resizer (D11b decision 4): it can be
 * selected, never resized.
 */
export function PipelineGroupNode({ data, selected }: NodeProps<OTelNode>) {
  const color = data.color;
  const readOnly = useEditorStore(selectIsVersionPublished);
  return (
    <div
      className="relative h-full w-full rounded-lg border border-dashed"
      style={{ borderColor: color, backgroundColor: color ? `${color}0D` : undefined }}
    >
      <NodeResizer
        minWidth={GROUP_MIN_WIDTH}
        minHeight={GROUP_MIN_HEIGHT}
        isVisible={selected && !readOnly}
        lineClassName="!border-transparent"
        handleClassName="!w-2.5 !h-2.5 !bg-white !border-2 !rounded-sm"
        handleStyle={{ borderColor: color }}
      />
      <Handle
        type="target"
        id={GROUP_TARGET_HANDLE}
        position={Position.Left}
        isConnectable={false}
        className="!pointer-events-none !opacity-0 !border-0"
      />
      <Handle
        type="source"
        id={GROUP_SOURCE_HANDLE}
        position={Position.Right}
        isConnectable={false}
        className="!pointer-events-none !opacity-0 !border-0"
      />
      <div
        className="absolute -top-2.5 left-3 max-w-[calc(100%-1.5rem)] truncate whitespace-nowrap rounded-[4px] px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.05em] text-white"
        style={{ backgroundColor: color, textShadow: "0 1px 2px rgba(0,0,0,0.45)" }}
      >
        {groupBadgeLabel(data.label, data.signalType)}
      </div>
    </div>
  );
}
